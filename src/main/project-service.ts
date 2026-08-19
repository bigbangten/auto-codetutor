import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BuildContextInfo, CommentApplyRequest, CommentApplyResult, ProjectFile, ProjectSnapshot, ReferenceFolderInfo, SymbolRecord } from '../shared/contracts.js';
import { CParser, ProjectIndex, type ParsedFile } from './c-indexer.js';
import { ensureProjectDataDir, normalizeRelative, resolveReadableFile } from './security.js';
import { parseMexInventory } from './origin.js';
import { readJson, writeJsonAtomic } from './json-store.js';
import { ReferenceService, type ReferenceHit } from './reference-service.js';
import { loadBuildContext } from './build-context.js';

interface IndexCache {
  schema: 9;
  mexKey: string;
  parsedFiles: ParsedFile[];
}

const SKIP_DIRECTORIES = new Set([
  '.git', '.svn', '.hg', '.codetutor-next', 'node_modules',
  'debug', 'release', 'build', 'dist', 'out', '.cache',
]);
const MAX_SOURCE_SIZE = 8 * 1024 * 1024;
const MAX_FILES = 25_000;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function extractCode(output: string): string {
  const fenced = output.match(/```(?:c|cpp|h)?\s*\r?\n([\s\S]*?)```/i);
  return (fenced?.[1] ?? output).trimEnd();
}

function codeWithoutCommentsOrWhitespace(source: string): string {
  let output = '';
  let mode: 'code' | 'line' | 'block' | 'string' | 'char' = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!;
    const next = source[index + 1] ?? '';
    if (mode === 'line') { if (current === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (current === '*' && next === '/') { mode = 'code'; index += 1; } continue; }
    if (mode === 'string' || mode === 'char') {
      output += current;
      if (current === '\\') { output += next; index += 1; continue; }
      if ((mode === 'string' && current === '"') || (mode === 'char' && current === "'")) mode = 'code';
      continue;
    }
    if (current === '/' && next === '/') { mode = 'line'; index += 1; continue; }
    if (current === '/' && next === '*') { mode = 'block'; index += 1; continue; }
    if (current === '"') { mode = 'string'; output += current; continue; }
    if (current === "'") { mode = 'char'; output += current; continue; }
    if (!/\s/.test(current)) output += current;
  }
  return output;
}

async function enumerate(root: string): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  const queue = [root];
  while (queue.length) {
    const directory = queue.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) throw new Error(`파일이 ${MAX_FILES.toLocaleString()}개를 넘어 인덱싱을 중단했습니다.`);
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLocaleLowerCase('en-US'))) queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLocaleLowerCase('en-US');
      if (!['.c', '.h', '.mex'].includes(extension)) continue;
      const fileStat = await stat(absolute);
      if (fileStat.size > MAX_SOURCE_SIZE) continue;
      files.push({
        path: normalizeRelative(root, absolute),
        kind: extension === '.c' ? 'c' : extension === '.h' ? 'header' : 'mex',
        size: fileStat.size,
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export class ProjectService {
  private rootPath: string | null = null;
  private dataDir: string | null = null;
  private index: ProjectIndex | null = null;
  private files: ProjectFile[] = [];
  private watcher: FSWatcher | null = null;
  private parser: CParser;
  private indexing = false;
  private readonly indexingWaiters: Array<() => void> = [];
  private rerunRequested = false;
  private debounce: NodeJS.Timeout | null = null;
  private updateListener: ((snapshot: ProjectSnapshot) => void) | null = null;
  private buildContext: BuildContextInfo = {
    enabled: false,
    available: false,
    configurations: [],
    note: '빌드 설정 인식이 꺼져 있습니다.',
  };
  readonly references: ReferenceService;

  constructor(runtimeWasm: string, grammarWasm: string) {
    this.parser = new CParser(runtimeWasm, grammarWasm);
    this.references = new ReferenceService(path.join(path.dirname(runtimeWasm), 'standard_fonts'));
  }

  onUpdated(listener: (snapshot: ProjectSnapshot) => void): void {
    this.updateListener = listener;
  }

  get root(): string | null { return this.rootPath; }
  get projectDataDir(): string | null { return this.dataDir; }
  get currentIndex(): ProjectIndex | null { return this.index; }

  async open(requestedRoot: string, buildContextEnabled = false, preferredBuildConfiguration?: string): Promise<ProjectSnapshot> {
    await this.close();
    const resolved = await realpath(requestedRoot);
    const rootStat = await lstat(resolved);
    if (!rootStat.isDirectory()) throw new Error('프로젝트 폴더가 아닙니다.');
    this.rootPath = resolved;
    this.dataDir = await ensureProjectDataDir(resolved);
    this.buildContext = await loadBuildContext(resolved, buildContextEnabled, preferredBuildConfiguration);
    await this.references.bind(this.dataDir);
    const snapshot = await this.reindex(false);
    this.startWatcher();
    return snapshot;
  }

  async close(): Promise<void> {
    this.closeWatcher();
    this.rerunRequested = false;
    if (this.indexing) await new Promise<void>((resolve) => this.indexingWaiters.push(resolve));
    this.rootPath = null;
    this.dataDir = null;
    this.index = null;
    this.files = [];
    this.buildContext = { enabled: false, available: false, configurations: [], note: '빌드 설정 인식이 꺼져 있습니다.' };
    this.references.unbind();
  }

  async refresh(): Promise<ProjectSnapshot> {
    if (!this.rootPath || !this.dataDir) throw new Error('프로젝트를 먼저 여세요.');
    while (this.indexing) await new Promise<void>((resolve) => this.indexingWaiters.push(resolve));
    this.buildContext = await loadBuildContext(this.rootPath, this.buildContext.enabled, this.buildContext.activeConfigurationId);
    return this.reindex(false);
  }

  snapshot(): ProjectSnapshot | null {
    const snapshot = this.index?.snapshot(this.files);
    return snapshot ? { ...snapshot, buildContext: this.buildContext } : null;
  }

  buildContextInfo(): BuildContextInfo { return this.buildContext; }

  async configureBuildContext(enabled: boolean, preferredBuildConfiguration?: string): Promise<BuildContextInfo> {
    if (!this.rootPath) {
      this.buildContext = { enabled, available: false, configurations: [], note: '열린 프로젝트가 없습니다.' };
      return this.buildContext;
    }
    this.buildContext = await loadBuildContext(this.rootPath, enabled, preferredBuildConfiguration);
    return this.buildContext;
  }

  async readSource(relativePath: string): Promise<string> {
    if (!this.rootPath) throw new Error('프로젝트를 먼저 여세요.');
    const target = await resolveReadableFile(this.rootPath, relativePath);
    const fileStat = await stat(target);
    if (fileStat.size > MAX_SOURCE_SIZE) throw new Error('파일이 너무 커서 열 수 없습니다.');
    return readFile(target, 'utf8');
  }

  getSymbol(id: string): SymbolRecord | null {
    return this.index?.getSymbol(id) ?? null;
  }

  semanticTargets(): SymbolRecord[] {
    if (!this.index) return [];
    return this.index.symbols
      .filter((symbol) => {
        const locations = [symbol.definition, symbol.declaration, ...symbol.references.map((reference) => reference.range), ...symbol.origin.anchors]
          .filter((range): range is NonNullable<typeof range> => Boolean(range));
        return locations.some((range) => /(?:^|\/)src\//i.test(range.file.replaceAll('\\', '/')));
      })
      .sort((a, b) => {
        const fileA = a.definition?.file ?? a.declaration.file;
        const fileB = b.definition?.file ?? b.declaration.file;
        return fileA.localeCompare(fileB) || (a.definition?.startLine ?? a.declaration.startLine) - (b.definition?.startLine ?? b.declaration.startLine);
      });
  }

  semanticSourceHash(): string {
    return hash(this.semanticTargets().map((symbol) => `${symbol.id}:${symbol.sourceHash}`).join('\n'));
  }

  semanticFileFor(symbol: SymbolRecord): string {
    const candidates = [symbol.definition, symbol.declaration, ...symbol.references.map((reference) => reference.range), ...symbol.origin.anchors]
      .filter((range): range is NonNullable<typeof range> => Boolean(range));
    return candidates.find((range) => /(?:^|\/)src\//i.test(range.file.replaceAll('\\', '/')))?.file
      ?? (symbol.definition ?? symbol.declaration).file;
  }

  getSymbolAt(input: { file: string; line: number; column: number; word: string }): SymbolRecord | null {
    return this.index?.getSymbolAt(input.file, input.line, input.column, input.word) ?? null;
  }

  referenceStatus(): ReferenceFolderInfo { return this.references.status(); }
  setReferenceFolder(folder: string): Promise<ReferenceFolderInfo> { return this.references.setFolder(folder); }
  clearReferenceFolder(): Promise<ReferenceFolderInfo> { return this.references.clear(); }
  searchReferences(query: string, limit = 6): ReferenceHit[] { return this.references.search(query, limit); }

  async applyGeneratedComments(request: CommentApplyRequest): Promise<CommentApplyResult> {
    if (!this.rootPath || !this.dataDir) throw new Error('프로젝트를 먼저 여세요.');
    if (!Number.isInteger(request.startLine) || !Number.isInteger(request.endLine) || request.startLine < 1 || request.endLine < request.startLine) {
      throw new Error('주석 적용 범위가 올바르지 않습니다.');
    }
    const target = await resolveReadableFile(this.rootPath, request.file);
    const source = await readFile(target, 'utf8');
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const lines = source.split(/\r?\n/);
    if (request.endLine > lines.length) throw new Error('파일이 변경되어 선택 범위를 찾을 수 없습니다.');
    const original = lines.slice(request.startLine - 1, request.endLine).join('\n');
    if (hash(original) !== request.codeHash) throw new Error('AI 분석 후 코드가 변경되었습니다. 다시 생성해 주세요.');
    const generated = extractCode(request.aiOutput).replace(/\r\n/g, '\n');
    if (!generated.trim()) throw new Error('AI가 적용 가능한 코드를 반환하지 않았습니다.');
    if (codeWithoutCommentsOrWhitespace(original) !== codeWithoutCommentsOrWhitespace(generated)) {
      return { applied: false, reason: '주석 이외의 코드 토큰 변경이 감지되어 적용을 차단했습니다.' };
    }

    const backupDir = path.join(this.dataDir, 'comment-backups');
    await mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = request.file.replace(/[^a-z0-9._-]+/gi, '_');
    const backup = path.join(backupDir, `${stamp}-${safeName}.bak`);
    await copyFile(target, backup);
    const next = [...lines.slice(0, request.startLine - 1), ...generated.split('\n'), ...lines.slice(request.endLine)].join(eol);
    await writeFile(target, next, 'utf8');
    const snapshot = await this.reindex(true);
    this.updateListener?.(snapshot);
    return { applied: true, backupPath: normalizeRelative(this.rootPath, backup) };
  }

  async reindex(force = false): Promise<ProjectSnapshot> {
    if (!this.rootPath || !this.dataDir) throw new Error('프로젝트를 먼저 여세요.');
    if (this.indexing) {
      this.rerunRequested = true;
      const existing = this.snapshot();
      if (existing) return existing;
      throw new Error('첫 인덱싱이 진행 중입니다.');
    }
    this.indexing = true;
    try {
      const files = await enumerate(this.rootPath);
      const mexFiles = files.filter((file) => file.kind === 'mex');
      const mexSources = await Promise.all(mexFiles.map(async (file) => ({ path: file.path, source: await this.readSource(file.path) })));
      const mexInventory = parseMexInventory(mexSources);
      const mexKey = hash(mexSources.map((item) => `${item.path}\0${item.source}`).join('\0'));
      const cacheFile = path.join(this.dataDir, 'index-v9.json');
      const diskCache = force ? null : await readJson<IndexCache | null>(cacheFile, null);
      const validCache = diskCache?.schema === 9 ? diskCache : null;
      const cachedByPath = new Map((validCache?.parsedFiles ?? []).map((entry) => [entry.file.path, entry]));
      const mexUnchanged = validCache?.mexKey === mexKey;
      const aiMetadata = await readJson<{ files?: string[] }>(path.join(this.dataDir, 'ai-authorship.json'), {});
      const aiConfirmed = new Set((aiMetadata.files ?? []).map((file) => file.replaceAll('\\', '/')));
      const parsedFiles: ParsedFile[] = [];
      for (const file of files.filter((candidate) => candidate.kind !== 'mex')) {
        const source = await this.readSource(file.path);
        const sourceHash = hash(source);
        const cached = cachedByPath.get(file.path);
        if (!force && mexUnchanged && cached?.hash === sourceHash) {
          parsedFiles.push(cached);
        } else {
          parsedFiles.push(await this.parser.parse(file, source, mexInventory, aiConfirmed));
        }
      }
      this.files = files;
      this.index = new ProjectIndex(this.rootPath, parsedFiles);
      await writeJsonAtomic(cacheFile, { schema: 9, mexKey, parsedFiles } satisfies IndexCache);
      return this.snapshot()!;
    } finally {
      this.indexing = false;
      const waiters = this.indexingWaiters.splice(0);
      waiters.forEach((resolve) => resolve());
      if (this.rerunRequested) {
        this.rerunRequested = false;
        void this.reindex(false).then((snapshot) => this.updateListener?.(snapshot)).catch(() => undefined);
      }
    }
  }

  private startWatcher(): void {
    if (!this.rootPath) return;
    try {
      this.watcher = watch(this.rootPath, { recursive: true }, (_event, filename) => {
        const relative = filename?.toString().replaceAll('\\', '/') ?? '';
        if (!relative || relative.startsWith('.codetutor-next/') || !/\.(?:c|h|mex)$/i.test(relative)) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          void this.reindex(false).then((snapshot) => this.updateListener?.(snapshot)).catch(() => undefined);
        }, 650);
      });
    } catch {
      // Network drives and some older Windows filesystems do not support recursive watch.
      // Manual project reopen remains available; analysis itself is unaffected.
      this.watcher = null;
    }
  }

  private closeWatcher(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.watcher?.close();
    this.watcher = null;
  }

  dispose(): void {
    this.closeWatcher();
    this.references.unbind();
  }
}
