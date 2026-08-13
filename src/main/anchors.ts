import { readFile, stat } from 'node:fs/promises';
import type { AnchorValidation, SourceRange } from '../shared/contracts.js';
import { normalizeRelative, resolveReadableFile } from './security.js';

const ANCHOR_RE = /\[\[([^\[\]\r\n:]+):(\d+)(?:-(\d+))?\]\]/g;
const DOCUMENT_ANCHOR_RE = /\[\[([^\[\]\r\n:]+):p\.(\d+)\]\]/g;

export function parseAnchors(markdown: string): Array<{ raw: string; file: string; start: number; end: number }> {
  const result: Array<{ raw: string; file: string; start: number; end: number }> = [];
  for (const match of markdown.matchAll(ANCHOR_RE)) {
    const start = Number(match[2]);
    result.push({ raw: match[0], file: match[1]!.trim().replaceAll('\\', '/'), start, end: Number(match[3] ?? start) });
  }
  return result;
}

export async function validateMarkdownAnchors(root: string, markdown: string): Promise<AnchorValidation[]> {
  const parsed = parseAnchors(markdown);
  const lineCounts = new Map<string, number>();
  const out: AnchorValidation[] = [];
  for (const anchor of parsed) {
    try {
      if (anchor.start < 1 || anchor.end < anchor.start) throw new Error('줄 범위가 올바르지 않습니다.');
      const absolute = await resolveReadableFile(root, anchor.file);
      const fileStat = await stat(absolute);
      if (fileStat.size > 8 * 1024 * 1024) throw new Error('파일이 너무 큽니다.');
      let lineCount = lineCounts.get(absolute);
      if (lineCount === undefined) {
        lineCount = (await readFile(absolute, 'utf8')).split(/\r?\n/).length;
        lineCounts.set(absolute, lineCount);
      }
      if (anchor.end > lineCount) throw new Error(`파일은 ${lineCount}줄까지 있습니다.`);
      const relative = normalizeRelative(root, absolute);
      const range: SourceRange = {
        file: relative,
        startLine: anchor.start,
        startColumn: 1,
        endLine: anchor.end,
        endColumn: 1,
      };
      out.push({ raw: anchor.raw, valid: true, range });
    } catch (error) {
      out.push({ raw: anchor.raw, valid: false, reason: (error as Error).message });
    }
  }
  return out;
}

export function validateDocumentAnchors(
  markdown: string,
  hasDocument: (name: string, page: number) => boolean,
): AnchorValidation[] {
  const result: AnchorValidation[] = [];
  for (const match of markdown.matchAll(DOCUMENT_ANCHOR_RE)) {
    const name = match[1]!.trim().replaceAll('\\', '/');
    const page = Number(match[2]);
    const valid = hasDocument(name, page);
    result.push({
      raw: match[0],
      valid,
      document: valid ? { name, page } : undefined,
      reason: valid ? undefined : '레퍼런스 문서 또는 페이지를 찾을 수 없습니다.',
    });
  }
  return result;
}
