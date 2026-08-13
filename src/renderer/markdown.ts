import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { AnchorValidation, SourceRange } from '../shared/contracts.js';

const ANCHOR_RE = /\[\[[^\[\]\r\n]+:(?:\d+(?:-\d+)?|p\.\d+)\]\]/g;

export async function renderGroundedMarkdown(
  container: HTMLElement,
  markdown: string,
  validations: AnchorValidation[],
  navigate: (range: SourceRange) => void,
  openDocument?: (document: { name: string; page: number }) => void,
): Promise<void> {
  const html = await marked.parse(markdown, { breaks: true, gfm: true });
  container.innerHTML = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style', 'srcset'],
  });
  const byRaw = new Map<string, AnchorValidation[]>();
  for (const validation of validations) {
    const list = byRaw.get(validation.raw) ?? [];
    list.push(validation); byRaw.set(validation.raw, list);
  }
  const used = new Map<string, number>();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) {
    const value = node.nodeValue ?? '';
    const matches = [...value.matchAll(ANCHOR_RE)];
    if (!matches.length || !node.parentNode) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      const index = match.index ?? 0;
      fragment.append(document.createTextNode(value.slice(cursor, index)));
      const raw = match[0];
      const offset = used.get(raw) ?? 0;
      const validation = byRaw.get(raw)?.[offset];
      used.set(raw, offset + 1);
      const element = document.createElement(validation?.valid ? 'button' : 'span');
      element.className = `${validation?.document ? 'document-anchor' : 'code-anchor'} ${validation?.valid ? 'valid' : 'invalid'}`;
      element.textContent = raw.slice(2, -2);
      element.title = validation?.valid ? (validation.document ? `문서 ${validation.document.page}페이지 열기` : '코드로 이동') : validation?.reason ?? '검증되지 않은 근거';
      if (validation?.valid && validation.range) {
        element.addEventListener('click', (event) => { event.stopPropagation(); navigate(validation.range!); });
      } else if (validation?.valid && validation.document && openDocument) {
        element.addEventListener('click', (event) => { event.stopPropagation(); openDocument(validation.document!); });
      }
      fragment.append(element);
      cursor = index + raw.length;
    }
    fragment.append(document.createTextNode(value.slice(cursor)));
    node.parentNode.replaceChild(fragment, node);
  }
  for (const paragraph of container.querySelectorAll('p')) {
    const first = paragraph.querySelector<HTMLButtonElement>('.code-anchor.valid, .document-anchor.valid');
    if (!first) continue;
    paragraph.classList.add('grounded');
    paragraph.title = '이 설명의 첫 번째 코드 근거로 이동';
    paragraph.addEventListener('click', (event) => { if (!(event.target as HTMLElement).closest('.code-anchor')) first.click(); });
  }
}
