import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ReferenceDocument, ReferenceFolderInfo } from '../shared/contracts.js';
import { readJson, writeJsonAtomic } from './json-store.js';
import { isPathInside } from './security.js';

interface IndexedDocument extends ReferenceDocument {
  fingerprint: string;
  content: string[];
}

interface ReferenceIndex {
  schema: 1;
  folderPath: string;
  indexedAt: string;
  documents: IndexedDocument[];
}

export interface ReferenceHit {
  document: string;
  page: number;
  excerpt: string;
  score: number;
  citation: string;
}

const SUPPORTED = new Set(['.pdf', '.txt', '.md', '.csv', '.log']);
const MAX_DOCUMENTS = 200;
const MAX_DOCUMENT_SIZE = 128 * 1024 * 1024;
const MAX_PAGES_PER_DOCUMENT = 4_000;

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function tokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase('ko-KR').match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 32);
}

function excerptAround(text: string, terms: string[], max = 1_400): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  const lowered = compact.toLocaleLowerCase('ko-KR');
  const positions = terms.map((term) => lowered.indexOf(term)).filter((index) => index >= 0);
  const center = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, Math.min(compact.length - max, center - Math.floor(max * 0.25)));
  return `${start ? '…' : ''}${compact.slice(start, start + max)}${start + max < compact.length ? '…' : ''}`;
}

async function enumerate(folder: string): Promise<Array<{ absolute: string; relative: string; fingerprint: string }>> {
  const result: Array<{ absolute: string; relative: string; fingerprint: string }> = [];
  const queue = [folder];
  while (queue.length && result.length < MAX_DOCUMENTS) {
    const directory = queue.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= MAX_DOCUMENTS) break;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { queue.push(absolute); continue; }
      if (!entry.isFile() || !SUPPORTED.has(path.extname(entry.name).toLocaleLowerCase('en-US'))) continue;
      const info = await stat(absolute);
      if (info.size > MAX_DOCUMENT_SIZE) continue;
      const relative = normalizedRelative(folder, absolute);
      result.push({ absolute, relative, fingerprint: sha(`${relative}\0${info.size}\0${info.mtimeMs}`) });
    }
  }
  return result;
}

async function extractPdf(file: string, standardFontDir: string): Promise<string[]> {
  const bytes = new Uint8Array(await readFile(file));
  const standardFontDataUrl = `${standardFontDir.replaceAll('\\', '/').replace(/\/$/, '')}/`;
  const task = getDocument({ data: bytes, standardFontDataUrl });
  const pdf = await task.promise;
  const pages: string[] = [];
  try {
    const count = Math.min(pdf.numPages, MAX_PAGES_PER_DOCUMENT);
    for (let number = 1; number <= count; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pages.push(text);
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

async function extractText(file: string): Promise<string[]> {
  const source = await readFile(file, 'utf8');
  const chunks: string[] = [];
  for (let offset = 0; offset < source.length; offset += 12_000) chunks.push(source.slice(offset, offset + 12_000));
  return chunks.length ? chunks : [''];
}

export class ReferenceService {
  private dataDir: string | null = null;
  private index: ReferenceIndex | null = null;

  constructor(private readonly standardFontDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts')) {}

  async bind(dataDir: string): Promise<void> {
    this.dataDir = dataDir;
    const settings = await readJson<{ folderPath?: string }>(path.join(dataDir, 'reference-settings.json'), {});
    if (!settings.folderPath) { this.index = null; return; }
    const cached = await readJson<ReferenceIndex | null>(path.join(dataDir, 'reference-index-v1.json'), null);
    try {
      const folder = await realpath(settings.folderPath);
      if (!(await lstat(folder)).isDirectory()) throw new Error('not directory');
      this.index = cached?.schema === 1 && cached.folderPath === folder ? cached : await this.build(folder, cached);
    } catch {
      this.index = null;
    }
  }

  unbind(): void {
    this.dataDir = null;
    this.index = null;
  }

  private requireDataDir(): string {
    if (!this.dataDir) throw new Error('프로젝트를 먼저 여세요.');
    return this.dataDir;
  }

  async setFolder(requested: string): Promise<ReferenceFolderInfo> {
    const folder = await realpath(requested);
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('유효한 레퍼런스 폴더가 아닙니다.');
    await writeJsonAtomic(path.join(this.requireDataDir(), 'reference-settings.json'), { folderPath: folder });
    const cached = await readJson<ReferenceIndex | null>(path.join(this.requireDataDir(), 'reference-index-v1.json'), null);
    this.index = await this.build(folder, cached);
    return this.status();
  }

  async clear(): Promise<ReferenceFolderInfo> {
    await writeJsonAtomic(path.join(this.requireDataDir(), 'reference-settings.json'), {});
    this.index = null;
    return this.status();
  }

  status(): ReferenceFolderInfo {
    return {
      folderPath: this.index?.folderPath ?? null,
      documents: (this.index?.documents ?? []).map(({ content: _content, fingerprint: _fingerprint, ...document }) => document),
      indexedPages: (this.index?.documents ?? []).reduce((sum, document) => sum + document.content.length, 0),
      indexedAt: this.index?.indexedAt,
    };
  }

  private async build(folder: string, cached: ReferenceIndex | null): Promise<ReferenceIndex> {
    const files = await enumerate(folder);
    const cachedByPath = new Map((cached?.folderPath === folder ? cached.documents : []).map((document) => [document.relativePath, document]));
    const documents: IndexedDocument[] = [];
    for (const file of files) {
      const previous = cachedByPath.get(file.relative);
      if (previous?.fingerprint === file.fingerprint) { documents.push(previous); continue; }
      try {
        const pdf = path.extname(file.relative).toLocaleLowerCase('en-US') === '.pdf';
        const content = pdf ? await extractPdf(file.absolute, this.standardFontDir) : await extractText(file.absolute);
        documents.push({
          name: path.basename(file.relative),
          relativePath: file.relative,
          kind: pdf ? 'pdf' : 'text',
          pages: content.length,
          fingerprint: file.fingerprint,
          content,
        });
      } catch {
        // One damaged or encrypted document must not make the whole reference folder unusable.
      }
    }
    const index: ReferenceIndex = { schema: 1, folderPath: folder, indexedAt: new Date().toISOString(), documents };
    await writeJsonAtomic(path.join(this.requireDataDir(), 'reference-index-v1.json'), index);
    return index;
  }

  search(query: string, limit = 6): ReferenceHit[] {
    const terms = tokens(query);
    if (!terms.length || !this.index) return [];
    const hits: ReferenceHit[] = [];
    for (const document of this.index.documents) {
      const name = document.relativePath.toLocaleLowerCase('ko-KR');
      for (let pageIndex = 0; pageIndex < document.content.length; pageIndex += 1) {
        const page = document.content[pageIndex] ?? '';
        const lowered = page.toLocaleLowerCase('ko-KR');
        let score = 0;
        for (const term of terms) {
          if (name.includes(term)) score += 6;
          const first = lowered.indexOf(term);
          if (first >= 0) score += 2 + Math.min(4, lowered.split(term).length - 1);
        }
        if (!score) continue;
        hits.push({
          document: document.relativePath,
          page: pageIndex + 1,
          excerpt: excerptAround(page, terms),
          score,
          citation: `[[${document.relativePath}:p.${pageIndex + 1}]]`,
        });
      }
    }
    return hits.sort((a, b) => b.score - a.score || a.document.localeCompare(b.document) || a.page - b.page).slice(0, limit);
  }

  hasDocument(name: string, page: number): boolean {
    const document = this.index?.documents.find((item) => item.relativePath === name || item.name === name);
    return Boolean(document && Number.isInteger(page) && page >= 1 && page <= document.pages);
  }

  async resolveDocument(name: string): Promise<string> {
    const index = this.index;
    if (!index) throw new Error('레퍼런스 폴더가 지정되지 않았습니다.');
    const document = index.documents.find((item) => item.relativePath === name || item.name === name);
    if (!document) throw new Error('레퍼런스 문서를 찾을 수 없습니다.');
    const target = await realpath(path.join(index.folderPath, document.relativePath));
    if (!isPathInside(index.folderPath, target) || !(await lstat(target)).isFile()) throw new Error('레퍼런스 문서 경로가 안전하지 않습니다.');
    return target;
  }
}
