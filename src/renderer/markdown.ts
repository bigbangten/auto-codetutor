import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { AnchorValidation, SourceRange } from '../shared/contracts.js';
import { nearestGroundedBlock } from '../shared/grounding.js';

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
  const blocks = [...container.querySelectorAll<HTMLElement>(
    ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > p, :scope > pre, :scope > blockquote, :scope > ul > li, :scope > ol > li, :scope > table',
  )];
  let section = 0;
  const sectionByIndex = blocks.map((block) => {
    if (/^H[1-4]$/.test(block.tagName)) section += 1;
    return section;
  });
  const directGrounding = new Map<number, HTMLButtonElement>();
  blocks.forEach((block, index) => {
    const first = block.querySelector<HTMLButtonElement>('.code-anchor.valid, .document-anchor.valid');
    if (first) directGrounding.set(index, first);
  });
  const groundedIndices = [...directGrounding.keys()];

  blocks.forEach((block, index) => {
    const groundedIndex = nearestGroundedBlock(index, groundedIndices, sectionByIndex);
    if (groundedIndex === undefined) return;
    const anchorButton = directGrounding.get(groundedIndex);
    if (!anchorButton) return;
    const direct = groundedIndex === index;
    const activate = () => anchorButton.click();
    block.classList.add('grounded');
    block.dataset.grounding = direct ? 'direct' : 'nearby';
    block.title = direct ? '이 설명의 코드 근거로 이동' : '이 설명과 가장 가까운 코드 근거로 이동';
    block.tabIndex = 0;
    block.setAttribute('role', 'link');
    block.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('button, a, input, select, textarea, summary, .code-anchor, .document-anchor')) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;
      activate();
    });
    block.addEventListener('keydown', (event) => {
      if (event.target !== block || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      activate();
    });
  });
}
