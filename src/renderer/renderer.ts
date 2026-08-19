import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/cpp/register.js';
import type {
  AIJob,
  AIJobEvent,
  AIRequest,
  AISelection,
  AnalysisCacheState,
  AnchorValidation,
  AppCommand,
  AppSettings,
  BackgroundAnalysisStatus,
  CallGraph,
  ChatThread,
  CodeTutorApi,
  CommentApplyResult,
  EngineInfo,
  FieldInfo,
  ProjectInsight,
  ProjectSnapshot,
  ReferenceFolderInfo,
  QuizSession,
  SourceRange,
  StudyNote,
  SymbolInsight,
  SymbolRecord,
} from '../shared/contracts.js';
import { renderFlowOverview, type FlowLocation } from './graph.js';
import { renderGroundedMarkdown } from './markdown.js';
import { describeCType } from '../shared/c-types.js';
import { C_OPERATOR_TOKENS, describeCToken, isCReservedWord, isDirectNumericLiteral, type CTokenExplanation } from '../shared/c-glossary.js';
import { removeCComments } from '../shared/c-comments.js';
import { splitCommentText } from '../shared/c-comment-chunks.js';
import { clampDraggedPaneWidth, clampPaneWidths } from '../shared/pane-layout.js';

declare global { interface Window { codeTutor: CodeTutorApi } }

const COMMENT_CHUNK_CHARACTERS = 48_000;

interface CommentBatch {
  target: AISelection;
  chunks: AISelection[];
  outputs: string[];
  activeIndex: number;
  request: Pick<AIRequest, 'commentMode' | 'commentLanguage' | 'commentInstruction' | 'engine' | 'model' | 'effort' | 'fast'>;
}

(self as typeof self & { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new Worker('./monaco-worker.js'),
};

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`필수 UI 요소를 찾을 수 없습니다: ${id}`);
  return node as T;
};

const state: {
  snapshot: ProjectSnapshot | null;
  currentFile: string | null;
  currentSymbol: SymbolRecord | null;
  currentSelection: AISelection | null;
  questionContext: AISelection | null;
  engines: EngineInfo[];
  jobs: Map<string, AIJob>;
  activeExplainJob: string | null;
  currentChatId: string | null;
  currentNoteId: string | null;
  graph: CallGraph | null;
  graphFocusId: string | null;
  flowLocation: FlowLocation | null;
  graphReset: (() => void) | null;
  expandedFolders: Set<string>;
  decorations: string[];
  settings: AppSettings | null;
  reference: ReferenceFolderInfo | null;
  symbolSummaryJobs: Map<string, string>;
  activeCommentJob: string | null;
  commentTarget: AISelection | null;
  commentOutput: string;
  commentBatch: CommentBatch | null;
  analysisStatus: BackgroundAnalysisStatus | null;
  projectInsight: ProjectInsight | null;
  symbolInsights: Map<string, SymbolInsight>;
} = {
  snapshot: null, currentFile: null, currentSymbol: null, currentSelection: null, questionContext: null,
  engines: [], jobs: new Map(), activeExplainJob: null, currentChatId: null,
  currentNoteId: null, graph: null, graphFocusId: null, flowLocation: null,
  graphReset: null, expandedFolders: new Set(), decorations: [], settings: null, reference: null,
  symbolSummaryJobs: new Map(), activeCommentJob: null, commentTarget: null, commentOutput: '', commentBatch: null,
  analysisStatus: null, projectInsight: null, symbolInsights: new Map(),
};

monaco.editor.defineTheme('codetutor-vscode', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1e1e1e',
    'editorLineNumber.foreground': '#858585',
    'editorLineNumber.activeForeground': '#c6c6c6',
    'editor.selectionBackground': '#264f78',
    'editor.inactiveSelectionBackground': '#3a3d41',
    'editor.lineHighlightBackground': '#2a2d2e80',
  },
});

const editor = monaco.editor.create($('editor'), {
  value: '// 프로젝트를 열면 코드가 여기에 표시됩니다.\n',
  language: 'cpp',
  theme: 'codetutor-vscode',
  readOnly: true,
  domReadOnly: true,
  automaticLayout: true,
  minimap: { enabled: false },
  fontFamily: 'Cascadia Mono, Consolas, monospace',
  fontSize: 14,
  lineHeight: 22,
  glyphMargin: true,
  folding: true,
  renderWhitespace: 'selection',
  smoothScrolling: true,
  wordWrap: 'off',
  lineNumbersMinChars: 3,
  overviewRulerBorder: false,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  padding: { top: 8, bottom: 20 },
  contextmenu: false,
});

let inspectionSequence = 0;

function setStatus(message: string, error = false): void {
  $('status-message').textContent = message;
  if (error) toast(message, true);
}

function toast(message: string, error = false): void {
  const item = document.createElement('div');
  item.className = `toast${error ? ' error' : ''}`;
  item.textContent = message;
  $('toast-region').append(item);
  setTimeout(() => item.remove(), 4200);
}

async function guarded<T>(action: () => Promise<T>, label = '작업'): Promise<T | null> {
  try { return await action(); }
  catch (error) { setStatus(`${label} 실패: ${(error as Error).message}`, true); return null; }
}

function relativeLabel(file: string): string { return file.replaceAll('\\', '/'); }

async function sha256(value: string): Promise<string> {
  const data = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(data)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function activateTab(name: string, persist = true): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('#right-tabs button')) button.classList.toggle('active', button.dataset.tab === name);
  for (const panel of document.querySelectorAll<HTMLElement>('.tab-panel')) panel.classList.toggle('active', panel.id === `tab-${name}`);
  if (persist && state.snapshot) void window.codeTutor.saveUiState({ activeTab: name });
  if (name === 'flow') {
    renderCurrentFlow();
    setTimeout(() => state.graphReset?.(), 20);
  }
}

function updateBreadcrumbs(): void {
  const nav = $('breadcrumbs'); nav.replaceChildren();
  const parts = [state.snapshot?.rootName, state.currentFile, state.currentSymbol?.name].filter((part): part is string => Boolean(part));
  if (!parts.length) { nav.textContent = '프로젝트를 열어 주세요'; return; }
  parts.forEach((part, index) => {
    if (index) { const separator = document.createElement('span'); separator.className = 'sep'; separator.textContent = '›'; nav.append(separator); }
    const span = document.createElement('span'); span.textContent = part; span.title = part; nav.append(span);
  });
}

function setIndexState(text: string, mode: 'busy' | 'ready' | '' = ''): void {
  const node = $('index-state'); node.textContent = text; node.className = `status-pill ${mode}`;
}

interface Folder { folders: Map<string, Folder>; files: string[] }
function fileHierarchy(files: string[]): Folder {
  const root: Folder = { folders: new Map(), files: [] };
  for (const file of files) {
    const segments = file.split('/'); let cursor = root;
    segments.slice(0, -1).forEach((segment) => {
      if (!cursor.folders.has(segment)) cursor.folders.set(segment, { folders: new Map(), files: [] });
      cursor = cursor.folders.get(segment)!;
    });
    cursor.files.push(segments.at(-1)!);
  }
  return root;
}

function fileButton(path: string, label: string): HTMLButtonElement {
  const button = document.createElement('button'); button.className = `tree-file${path === state.currentFile ? ' active' : ''}`; button.dataset.file = path;
  const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = path.endsWith('.h') ? 'H' : path.endsWith('.mex') ? 'M' : 'C';
  const text = document.createElement('span'); text.textContent = label; text.title = path;
  button.append(icon, text); button.addEventListener('click', () => void openFile(path)); return button;
}

function renderFolder(folder: Folder, prefix = ''): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const [name, child] of [...folder.folders.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const folderPath = prefix ? `${prefix}/${name}` : name;
    const details = document.createElement('details'); details.className = 'tree-folder'; details.open = state.expandedFolders.has(folderPath);
    details.addEventListener('toggle', () => {
      if (details.open) state.expandedFolders.add(folderPath);
      else state.expandedFolders.delete(folderPath);
    });
    const summary = document.createElement('summary'); summary.textContent = name; details.append(summary);
    const children = document.createElement('div'); children.className = 'tree-children'; children.append(renderFolder(child, folderPath)); details.append(children); fragment.append(details);
  }
  for (const name of folder.files.sort()) fragment.append(fileButton(prefix ? `${prefix}/${name}` : name, name));
  return fragment;
}

function renderProjectNavigator(query = ''): void {
  if (!state.snapshot) return;
  const term = query.trim().toLocaleLowerCase('ko-KR');
  const paths = state.snapshot.files.map((file) => file.path).filter((file) => !term || file.toLocaleLowerCase('ko-KR').includes(term));
  const tree = $('file-tree'); tree.replaceChildren();
  if (term) paths.forEach((path) => tree.append(fileButton(path, path)));
  else tree.append(renderFolder(fileHierarchy(paths)));

  const list = $('symbol-list'); list.replaceChildren();
  state.snapshot.symbols.filter((symbol) => !term || `${symbol.name} ${symbol.file}`.toLocaleLowerCase('ko-KR').includes(term)).slice(0, 500).forEach((symbol) => {
    const button = document.createElement('button'); button.className = 'symbol-row';
    const kind = document.createElement('span'); kind.className = 'file-icon'; kind.textContent = symbol.kind.slice(0, 1).toLocaleUpperCase('ko-KR');
    const name = document.createElement('span'); name.textContent = symbol.name;
    const file = document.createElement('small'); file.textContent = `${symbol.file}:${symbol.line}`;
    button.append(kind, name, file); button.addEventListener('click', () => {
      activateTab('symbol');
      void selectSymbol(symbol.id, true);
    }); list.append(button);
  });
}

async function openFile(file: string, highlight?: SourceRange): Promise<void> {
  inspectionSequence += 1;
  const source = await guarded(() => window.codeTutor.readSource(file), '파일 열기');
  if (source === null) return;
  state.currentFile = file;
  editor.setValue(source);
  monaco.editor.setModelLanguage(editor.getModel()!, 'cpp');
  $('current-file').textContent = relativeLabel(file);
  $<HTMLButtonElement>('generate-comments').disabled = false;
  $('welcome').hidden = true;
  renderProjectNavigator(($<HTMLInputElement>('file-search')).value);
  updateBreadcrumbs();
  if (state.snapshot) void window.codeTutor.saveUiState({ lastFile: file });
  if (highlight) {
    state.decorations = editor.deltaDecorations(state.decorations, [{
      range: new monaco.Range(highlight.startLine, highlight.startColumn, highlight.endLine, Math.max(highlight.endColumn, 1)),
      options: { isWholeLine: true, className: 'code-highlight-line', linesDecorationsClassName: 'code-highlight-glyph' },
    }]);
    editor.revealLinesInCenter(highlight.startLine, highlight.endLine, monaco.editor.ScrollType.Smooth);
    editor.setPosition({ lineNumber: highlight.startLine, column: highlight.startColumn });
  } else state.decorations = editor.deltaDecorations(state.decorations, []);
}

function clearCodeHighlight(): void {
  if (!state.decorations.length) return;
  state.decorations = editor.deltaDecorations(state.decorations, []);
}

async function navigate(range: SourceRange): Promise<void> { await openFile(range.file, range); }

function section(title: string): HTMLElement {
  const node = document.createElement('section'); node.className = 'info-section';
  const heading = document.createElement('h3'); heading.textContent = title; node.append(heading); return node;
}

const kindLabels: Record<SymbolRecord['kind'], string> = {
  function: '함수', variable: '변수', parameter: '매개변수', typedef: '타입 별칭',
  struct: '구조체', union: '공용체', enum: '열거형', field: '필드', macro: '매크로',
};

const referenceLabels: Record<SymbolRecord['references'][number]['kind'], string> = {
  declaration: '선언', definition: '정의', read: '읽기', write: '값 변경', call: '호출',
};

const confidenceLabels: Record<SymbolRecord['origin']['confidence'], string> = {
  confirmed: '출처 확인', strong: '출처 근거 높음', limited: '작성자 확인 불가',
};

interface OriginPresentation {
  label: string;
  detail: string;
  className: 'user' | 'mex' | 'rtd' | 'ai-confirmed' | 'external' | 'unknown';
  confidence: string;
}

function originPresentation(symbol: SymbolRecord): OriginPresentation {
  const primaryFile = (symbol.definition ?? symbol.declaration).file.replaceAll('\\', '/');
  if (symbol.synthetic) {
    const standardLibrary = symbol.origin.label === 'C 표준 라이브러리';
    return {
      label: standardLibrary ? 'C 표준 라이브러리' : '외부 코드 · 정의 미포함',
      detail: standardLibrary
        ? 'C 표준에서 정한 함수 시그니처와 현재 프로젝트의 실제 호출 위치를 함께 표시합니다.'
        : symbol.synthetic === 'external-type'
        ? '이 타입은 현재 연 프로젝트 안에서 정의를 찾지 못했습니다. SDK 또는 컴파일러 헤더에 있을 가능성이 큽니다.'
        : '이 함수·변수·매크로는 현재 연 프로젝트 안에서 선언이나 정의를 찾지 못했습니다.',
      className: 'external',
      confidence: standardLibrary ? '표준 시그니처' : '프로젝트 외부',
    };
  }
  if (symbol.origin.kind === 'mex') return {
    label: 'MEX 자동 생성 코드',
    detail: 'S32 Configuration Tools(MEX)가 만든 코드로 판정했습니다. 직접 수정하면 재생성 시 덮어써질 수 있습니다.',
    className: 'mex', confidence: confidenceLabels[symbol.origin.confidence],
  };
  if (symbol.origin.kind === 'rtd') return {
    label: 'NXP RTD·SDK 공급 코드',
    detail: 'NXP 드라이버 또는 SDK가 제공한 코드로 판정했습니다. 애플리케이션 코드와 구분해서 보는 영역입니다.',
    className: 'rtd', confidence: confidenceLabels[symbol.origin.confidence],
  };
  if (symbol.origin.kind === 'ai-confirmed') return {
    label: 'AI 작성 기록 확인',
    detail: '신뢰 가능한 CodeTutor 작업 기록에서 AI가 작성한 코드임을 확인했습니다.',
    className: 'ai-confirmed', confidence: '작성 기록 확인',
  };
  if (/^src\//i.test(primaryFile)) return {
    label: '사용자 관리 코드',
    detail: 'src에 있고 MEX·RTD 생성 근거가 없어 사용자가 관리하는 코드 영역으로 분류했습니다. 사람 또는 AI 중 누가 작성했는지는 작업 기록 없이는 확정할 수 없습니다.',
    className: 'user', confidence: '작성자 미확인',
  };
  return {
    label: '기타 프로젝트 코드',
    detail: 'MEX·RTD·AI 작성 근거를 찾지 못한 프로젝트 내부 코드입니다.',
    className: 'unknown', confidence: '출처 미확인',
  };
}

function compactDeclaration(value: string): string {
  const withoutComments = value.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' ');
  const compact = withoutComments.replace(/\s+/g, ' ').trim();
  return compact.length <= 260 ? compact : `${compact.slice(0, 257)}…`;
}

function appendSymbolAI(parent: HTMLElement, symbol: SymbolRecord): void {
  const card = document.createElement('section'); card.className = 'symbol-ai-card'; card.id = 'symbol-ai-card';
  const header = document.createElement('header');
  const heading = document.createElement('h3'); heading.textContent = 'AI 분석';
  const run = document.createElement('button'); run.className = 'ghost'; run.textContent = '분석 실행';
  run.addEventListener('click', () => {
    state.symbolSummaryJobs.delete(symbol.id);
    void startSymbolSummary(symbol);
  });
  header.append(heading, run);
  const status = document.createElement('div'); status.id = 'symbol-ai-status'; status.className = 'result-status';
  const insight = state.symbolInsights.get(symbol.id);
  status.textContent = insight
    ? insight.stale
      ? `이전 코드 기준 설명 · ${insight.model} · 현재 코드와 다를 수 있음`
      : `사전 분석 완료 · ${insight.model}`
    : state.analysisStatus && ['queued', 'running'].includes(state.analysisStatus.state)
      ? '백그라운드 사전 분석 대기 중 · 필요하면 분석 실행으로 우선 처리할 수 있습니다.'
      : '저장된 설명이 없습니다. 분석 실행을 누르면 전용 경량 모델로 분석합니다.';
  const output = document.createElement('article'); output.id = 'symbol-ai-output'; output.className = 'markdown-output';
  card.append(header, status, output); parent.append(card);
  if (insight) void renderSymbolInsight(insight);
  const existing = state.symbolSummaryJobs.get(symbol.id);
  const job = existing ? state.jobs.get(existing) : null;
  if (job && !insight) void showSymbolSummary(job, symbol.id);
}

async function renderSymbolInsight(insight: SymbolInsight): Promise<void> {
  if (insight.symbolId !== state.currentSymbol?.id || !document.getElementById('symbol-ai-output')) return;
  const status = $('symbol-ai-status'); const output = $('symbol-ai-output');
  status.className = `result-status${insight.stale ? ' stale' : ''}`;
  status.textContent = insight.stale
    ? `이전 코드 기준 역할 분석 · ${insight.model} · 변경 후 코드와 다를 수 있습니다.`
    : `역할·값·수정 영향 분석 완료 · ${insight.model}`;
  const markdown = withoutStructuredFunctionContract(insight.markdown);
  await renderGroundedMarkdown(output, markdown, await window.codeTutor.validateAnchors(markdown), (range) => void navigate(range), (document) => void openReferenceAnchor(document));
}

function withoutStructuredFunctionContract(markdown: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^###\s+입력과\s*반환\s*$/.test(line.trim())) { skipping = true; continue; }
    if (skipping && /^###\s+/.test(line.trim())) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function loadSymbolInsight(symbol: SymbolRecord, rerender = false): Promise<SymbolInsight | null> {
  const insight = await guarded(() => window.codeTutor.getSymbolInsight(symbol.id), '심볼 설명 조회');
  if (!insight) return null;
  state.symbolInsights.set(symbol.id, insight);
  if (state.currentSymbol?.id === symbol.id) {
    if (rerender) renderSymbol(symbol); else await renderSymbolInsight(insight);
  }
  return insight;
}

async function openReferenceAnchor(document: { name: string; page: number }): Promise<void> {
  const opened = await guarded(() => window.codeTutor.openReference(document), '레퍼런스 열기');
  if (opened === false) toast('레퍼런스 문서를 열 수 없습니다.', true);
}

async function showSymbolSummary(job: AIJob, expectedSymbolId = job.symbolId): Promise<void> {
  if (expectedSymbolId !== state.currentSymbol?.id || !document.getElementById('symbol-ai-card')) return;
  const status = $('symbol-ai-status'); const output = $('symbol-ai-output');
  if (job.state === 'error') { status.className = 'result-status'; status.textContent = `분석 오류: ${job.error}`; return; }
  if (job.state === 'queued' || job.state === 'running') {
    status.className = 'result-status running'; status.textContent = 'AI 분석 중…';
    if (job.output) output.textContent = job.output;
    return;
  }
  if (job.state !== 'done') return;
  const symbol = state.currentSymbol;
  if (symbol) {
    const insight = await loadSymbolInsight(symbol, true);
    if (insight) return;
  }
  status.className = 'result-status'; status.textContent = '분석은 완료됐지만 구조화된 설명을 불러오지 못했습니다.';
}

async function startSymbolSummary(symbol: SymbolRecord): Promise<void> {
  if (state.currentSymbol?.id !== symbol.id) return;
  const existingId = state.symbolSummaryJobs.get(symbol.id);
  const existing = existingId ? state.jobs.get(existingId) : null;
  if (existing && ['queued', 'running', 'done'].includes(existing.state)) { await showSymbolSummary(existing); return; }
  const status = document.getElementById('symbol-ai-status');
  if (status) { status.className = 'result-status running'; status.textContent = 'AI 분석 중…'; }
  const job = await guarded(() => window.codeTutor.analyzeSymbol(symbol.id), '심볼 AI 분석');
  if (!job) return;
  state.jobs.set(job.id, job); state.symbolSummaryJobs.set(symbol.id, job.id); renderJobs();
  await showSymbolSummary(job, symbol.id);
}

function sourceLink(range: SourceRange, label: string, meta?: string, detail?: string): HTMLButtonElement {
  const button = document.createElement('button'); button.className = 'source-link';
  const code = document.createElement('code'); code.textContent = label;
  const small = document.createElement('small'); small.textContent = meta ?? `${range.file}:${range.startLine}`;
  button.append(code, small);
  if (detail) { const description = document.createElement('span'); description.className = 'change-detail'; description.textContent = detail; description.title = detail; button.append(description); }
  button.addEventListener('click', () => void navigate(range)); return button;
}

function renderFields(
  fields: FieldInfo[],
  descriptions: Record<string, string> = {},
  prefix = '',
  selectedPath = '',
): HTMLUListElement {
  const list = document.createElement('ul'); list.className = 'field-tree';
  for (const field of fields) {
    const fieldPath = prefix ? `${prefix}.${field.name}` : field.name;
    const item = document.createElement('li'); const descriptor = document.createElement('span'); descriptor.className = 'field-descriptor';
    if (selectedPath && fieldPath === selectedPath) item.classList.add('selected-field');
    const code = document.createElement('code'); code.textContent = field.type;
    const name = document.createElement('span'); name.className = 'field-name'; name.textContent = field.name;
    descriptor.append(code, document.createTextNode(' '), name);
    if (field.type === 'enum 값') {
      const value = document.createElement('span'); value.className = 'enum-value';
      value.textContent = `= ${field.valueExpression ?? field.calculatedValue ?? '값 확인 필요'}`;
      descriptor.append(document.createTextNode(' '), value);
    }
    if (field.inferred) {
      const inferred = document.createElement('span'); inferred.className = 'field-inferred'; inferred.textContent = '사용 코드에서 복원';
      descriptor.append(document.createTextNode(' '), inferred);
    }
    item.append(descriptor);
    const jump = document.createElement('button'); jump.className = 'code-anchor'; jump.textContent = `${field.range.file}:${field.range.startLine}`; jump.addEventListener('click', () => void navigate(field.range)); item.append(jump);
    if (field.type === 'enum 값' && field.calculatedValue) {
      const calculated = document.createElement('p'); calculated.className = 'field-enum-result';
      const expanded = field.expandedValue ? `${field.expandedValue} → ` : '';
      calculated.textContent = `${expanded}${field.calculatedValue}`;
      item.append(calculated);
    }
    const meaning = descriptions[fieldPath] ?? descriptions[field.name];
    if (meaning) { const description = document.createElement('p'); description.className = 'field-meaning'; description.textContent = meaning; item.append(description); }
    else {
      const pending = document.createElement('p'); pending.className = 'field-meaning pending';
      const lower = field.name.toLocaleLowerCase('en-US');
      pending.textContent = lower === 'valid' || lower.endsWith('_valid')
        ? '이 설정이나 데이터가 유효한지 나타내는 플래그로 사용됩니다. 정확한 SDK 의미는 AI 재분석에서 보완합니다.'
        : lower === 'index' || lower.endsWith('_index')
          ? '대상 테이블이나 항목의 위치를 선택하는 인덱스로 사용됩니다. 정확한 범위는 SDK 타입 정의 확인이 필요합니다.'
          : /(?:rdwr|read.*write|write.*read)/.test(lower)
            ? '읽기와 쓰기 동작을 선택하는 설정으로 사용되는 것으로 보입니다. 정확한 값 의미는 SDK 정의 또는 AI 재분석에서 확인합니다.'
            : field.inferred
              ? '프로젝트의 멤버 접근에서 존재를 확인했습니다. 전체 AI 재분석 후 이 프로젝트에서의 구체적인 의미가 표시됩니다.'
              : '사전 분석 후 이 필드의 프로젝트 내 의미가 표시됩니다.';
      item.append(pending);
    }
    if (field.children.length) item.append(renderFields(field.children, descriptions, fieldPath, selectedPath)); list.append(item);
  }
  return list;
}

function effectiveTypeDescription(symbol: SymbolRecord): string {
  const insight = state.symbolInsights.get(symbol.id);
  if (insight?.typeDescription) return insight.typeDescription;
  const type = symbol.synthetic === 'external-type' ? symbol.name : symbol.type;
  return describeCType(type);
}

function appendTypeExplanation(parent: HTMLElement, symbol: SymbolRecord): void {
  const explanation = document.createElement('div'); explanation.className = 'type-explanation';
  const label = document.createElement('strong'); label.textContent = '타입 의미';
  const copy = document.createElement('p'); copy.textContent = effectiveTypeDescription(symbol);
  explanation.append(label, copy); parent.append(explanation);
}

function appendFunctionContract(parent: HTMLElement, symbol: SymbolRecord): void {
  const area = section('입력과 반환'); area.classList.add('function-contract-section');
  const insight = state.symbolInsights.get(symbol.id);
  const list = document.createElement('div'); list.className = 'function-contract';

  const parameterGroup = document.createElement('div'); parameterGroup.className = 'contract-group input-contract';
  const parameterHeading = document.createElement('strong'); parameterHeading.textContent = '입력 (Parameters)'; parameterGroup.append(parameterHeading);
  if (symbol.parameters.length) {
    for (const parameter of symbol.parameters) {
      const row = document.createElement('div'); row.className = 'contract-row';
      const signature = document.createElement('code'); signature.textContent = `${parameter.type} ${parameter.name}`;
      const description = document.createElement('p');
      description.textContent = insight?.parameterDescriptions?.[parameter.name]
        ?? `${describeCType(parameter.type)} 함수 호출 시 ${parameter.name}에 전달되는 입력입니다.`;
      const jump = document.createElement('button'); jump.className = 'code-anchor'; jump.textContent = `${parameter.range.file}:${parameter.range.startLine}`;
      jump.addEventListener('click', () => void navigate(parameter.range));
      row.append(signature, jump, description); parameterGroup.append(row);
    }
  } else if (symbol.synthetic === 'external-symbol') {
    const observedCalls = symbol.callers.filter((call) => call.arguments?.length);
    const maximum = observedCalls.reduce((count, call) => Math.max(count, call.arguments?.length ?? 0), 0);
    if (maximum) {
      const note = document.createElement('p'); note.className = 'contract-source-note';
      note.textContent = `선언은 프로젝트 밖에 있지만 실제 호출부에서 ${maximum}개 인자를 확인했습니다.`;
      parameterGroup.append(note);
      for (let index = 0; index < maximum; index += 1) {
        const samples = [...new Set(observedCalls.map((call) => call.arguments?.[index]).filter((value): value is string => Boolean(value)))].slice(0, 4);
        const row = document.createElement('div'); row.className = 'contract-row observed-parameter';
        const signature = document.createElement('code'); signature.textContent = `인자 ${index + 1} · ${samples.join(' / ') || '값 미확인'}`;
        const description = document.createElement('p');
        description.textContent = insight?.parameterDescriptions?.[`arg${index + 1}`]
          ?? describeObservedArgument(samples[0] ?? '', index + 1);
        row.append(signature, description); parameterGroup.append(row);
      }
    } else {
      const empty = document.createElement('p'); empty.className = 'contract-empty';
      empty.textContent = '프로젝트 내부 선언과 인자가 있는 호출부를 찾지 못해 매개변수 형식을 확인할 수 없습니다.';
      parameterGroup.append(empty);
    }
  } else {
    const empty = document.createElement('p'); empty.className = 'contract-empty';
    empty.textContent = '입력 매개변수가 없습니다.';
    parameterGroup.append(empty);
  }
  list.append(parameterGroup);

  const returnGroup = document.createElement('div'); returnGroup.className = 'contract-group return-contract';
  const returnHeading = document.createElement('strong'); returnHeading.textContent = '반환 (Return)'; returnGroup.append(returnHeading);
  const returnRow = document.createElement('div'); returnRow.className = 'contract-row return-row';
  const returnType = document.createElement('code'); returnType.textContent = symbol.type;
  const returnDescription = document.createElement('p');
  returnDescription.textContent = insight?.returnDescription
    ?? (/\bvoid\b/.test(symbol.type)
      ? '호출자에게 돌려주는 값이 없습니다.'
      : `${describeCType(symbol.type)} 이 형식의 처리 결과를 호출자에게 반환합니다.`);
  returnRow.append(returnType, returnDescription);
  if (symbol.returnExpressions.length) {
    const expressions = document.createElement('div'); expressions.className = 'return-expressions';
    const label = document.createElement('span'); label.textContent = '실제 반환식'; expressions.append(label);
    for (const value of symbol.returnExpressions.slice(0, 8)) { const code = document.createElement('code'); code.textContent = value; expressions.append(code); }
    returnRow.append(expressions);
  }
  returnGroup.append(returnRow); list.append(returnGroup);

  const callExamples = symbol.callers.filter((call) => call.arguments?.length).slice(0, 5);
  if (callExamples.length) {
    const examples = document.createElement('details'); examples.className = 'call-argument-examples';
    const summary = document.createElement('summary'); summary.textContent = `호출부 전달값 예시 · ${callExamples.length}`; examples.append(summary);
    for (const call of callExamples) {
      const button = sourceLink(call.range, `${call.name} → ${symbol.name}`, undefined, `인자: ${call.arguments!.join(', ')}`);
      examples.append(button);
    }
    list.append(examples);
  }
  area.append(list); parent.append(area);
}

function describeObservedArgument(value: string, position: number): string {
  if (!value) return `호출부에서 ${position}번째로 전달되는 값입니다. 정확한 타입은 SDK 선언을 확인해야 합니다.`;
  const address = value.match(/^&\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)$/)?.[1];
  if (address) return `${address}의 주소를 전달합니다. 함수가 이 객체를 읽거나 수정할 수 있으므로 호출 뒤 값 변화를 함께 확인해야 합니다.`;
  if (/^(?:NULL|nullptr)$/i.test(value)) return '널 포인터를 전달합니다. 이 인자를 선택 사항으로 허용하는지는 실제 SDK 선언을 확인해야 합니다.';
  if (/^sizeof\s*\(/.test(value)) return `${value}로 계산한 바이트 크기를 전달합니다.`;
  if (/^(?:[-+]?\d|0x|true$|false$|'.*'$|".*"$)/i.test(value)) return `고정 값 ${value}을(를) 전달합니다.`;
  return `${value}의 현재 값을 ${position}번째 인자로 전달합니다. 정확한 매개변수 타입은 외부 선언에서 확인해야 합니다.`;
}

function appendCallList(parent: HTMLElement, title: string, calls: SymbolRecord['calls'] | SymbolRecord['callers']): void {
  const unique = [...new Map(calls.map((call) => [`${call.range.file}:${call.range.startLine}:${call.range.startColumn}:${call.name}:${call.arguments?.join(',') ?? ''}`, call] as const)).values()]
    .sort((left, right) => callPathPriority(left.range.file) - callPathPriority(right.range.file)
      || left.range.file.localeCompare(right.range.file)
      || left.range.startLine - right.range.startLine);
  const area = section(`${title} · ${unique.length}`);
  if (!unique.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '확인된 항목 없음'; area.append(empty); }
  const appendCall = (call: (typeof unique)[number], host: HTMLElement): void => {
    const button = sourceLink(
      call.range,
      call.name,
      `${call.range.file}:${call.range.startLine}${call.resolved ? '' : ' · 정의 미해결'}`,
      call.arguments?.length ? `전달 인자: ${call.arguments.join(', ')}` : undefined,
    ); button.className = 'call-link';
    button.addEventListener('dblclick', () => { if (call.symbolId) void selectSymbol(call.symbolId, true); }); host.append(button);
  };
  unique.slice(0, 14).forEach((call) => appendCall(call, area));
  if (unique.length > 14) {
    const more = document.createElement('details'); more.className = 'compact-more call-list-more';
    const summary = document.createElement('summary'); summary.textContent = `추가 호출 ${unique.length - 14}개 보기`; more.append(summary);
    unique.slice(14).forEach((call) => appendCall(call, more)); area.append(more);
  }
  parent.append(area);
}

function callPathPriority(file: string): number {
  const normalized = file.replaceAll('\\', '/');
  if (/^src\//i.test(normalized)) return 0;
  if (/(?:^|\/)(?:app|application|source)(?:\/|$)/i.test(normalized)) return 1;
  if (/(?:^|\/)(?:SDK|RTD|middleware|generate|generated)(?:\/|$)/i.test(normalized)) return 3;
  return 2;
}

function appendReferences(parent: HTMLElement, title: string, references: SymbolRecord['references'], emphasis = false): void {
  const area = section(`${title} · ${references.length}`);
  if (!references.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = emphasis ? '정적 분석에서 확인된 값 변경 지점이 없습니다.' : '확인된 참조가 없습니다.';
    area.append(empty);
  }
  references.slice(0, 100).forEach((reference) => {
    const link = sourceLink(
      reference.range,
      `${referenceLabels[reference.kind]}${reference.container ? ` · ${reference.container}` : ''}${reference.target ? ` · ${reference.target}` : ''}`,
      undefined,
      reference.changeDescription ?? reference.expression,
    );
    if (reference.valueExpression && (reference.expandedValue || reference.calculatedValue)) {
      const expansion = document.createElement('span'); expansion.className = 'macro-expansion-detail';
      const label = document.createElement('span'); label.textContent = reference.expandedValue ? '매크로 치환' : '계산값';
      const original = document.createElement('code'); original.textContent = reference.valueExpression;
      expansion.append(label, original);
      if (reference.expandedValue) {
        const arrow = document.createElement('span'); arrow.textContent = '→';
        const expanded = document.createElement('code'); expanded.textContent = reference.expandedValue;
        expansion.append(arrow, expanded);
      }
      if (reference.calculatedValue) {
        const equals = document.createElement('span'); equals.textContent = '=';
        const calculated = document.createElement('code'); calculated.className = 'calculated'; calculated.textContent = reference.calculatedValue;
        expansion.append(equals, calculated);
      }
      link.append(expansion);
    }
    if (emphasis) link.classList.add('write-reference');
    area.append(link);
  });
  parent.append(area);
}

function appendMacroValue(parent: HTMLElement, symbol: SymbolRecord): void {
  if (symbol.kind !== 'macro') return;
  const card = document.createElement('div'); card.className = 'macro-value-card';
  const heading = document.createElement('strong');
  heading.textContent = symbol.macro?.functionLike ? '매크로 치환식' : '매크로 값';
  card.append(heading);

  if (!symbol.macro) {
    const unavailable = document.createElement('p');
    unavailable.textContent = '정의가 열린 프로젝트 밖에 있어 실제 치환값을 확인할 수 없습니다.';
    card.append(unavailable); parent.append(card); return;
  }

  if (symbol.macro.functionLike && symbol.macro.parameters.length) {
    const parameters = document.createElement('div'); parameters.className = 'macro-value-row';
    const label = document.createElement('span'); label.textContent = '매개변수';
    const code = document.createElement('code'); code.textContent = symbol.macro.parameters.join(', ');
    parameters.append(label, code); card.append(parameters);
  }
  const replacement = document.createElement('div'); replacement.className = 'macro-value-row';
  const replacementLabel = document.createElement('span'); replacementLabel.textContent = symbol.macro.functionLike ? '치환식' : '정의된 값';
  const replacementCode = document.createElement('code'); replacementCode.textContent = symbol.macro.replacement || '(빈 매크로)';
  replacement.append(replacementLabel, replacementCode); card.append(replacement);

  const expandedValue = symbol.macro.expandedReplacement;
  if (!symbol.macro.functionLike && expandedValue && expandedValue !== symbol.macro.replacement) {
    const expanded = document.createElement('div'); expanded.className = 'macro-value-row resolved';
    const expandedLabel = document.createElement('span'); expandedLabel.textContent = '최종 해석값';
    const expandedCode = document.createElement('code'); expandedCode.textContent = expandedValue;
    expanded.append(expandedLabel, expandedCode); card.append(expanded);
  }
  if (!symbol.macro.functionLike && symbol.macro.calculatedValue) {
    const calculated = document.createElement('div'); calculated.className = 'macro-value-row calculated';
    const calculatedLabel = document.createElement('span'); calculatedLabel.textContent = '계산 결과';
    const calculatedCode = document.createElement('code'); calculatedCode.textContent = symbol.macro.calculatedValue;
    calculated.append(calculatedLabel, calculatedCode); card.append(calculated);
  }
  const note = document.createElement('small');
  note.textContent = symbol.macro.functionLike
    ? '함수형 매크로는 호출 인자에 따라 최종 코드가 달라집니다.'
    : symbol.macro.calculatedValue
      ? '정수 리터럴과 안전한 산술·비트 연산만 계산했습니다. 타입 폭, 캐스팅, 오버플로가 개입하면 컴파일러 결과와 달라질 수 있습니다.'
      : '프로젝트 내부 객체형 매크로만 재귀적으로 치환했습니다. 컴파일러나 타입 정보가 필요한 식은 임의로 계산하지 않습니다.';
  card.append(note); parent.append(card);
}

function appendOriginEvidence(parent: HTMLElement, symbol: SymbolRecord, sourceRole: OriginPresentation): void {
  const evidence = document.createElement('details'); evidence.className = 'info-section origin-evidence';
  const heading = document.createElement('summary'); heading.textContent = '출처 및 판정 근거'; evidence.append(heading);
  const body = document.createElement('div'); body.className = 'origin-evidence-body';
  const summary = document.createElement('div'); summary.className = `origin-summary ${sourceRole.className}`;
  const sourceTitle = document.createElement('strong'); sourceTitle.textContent = sourceRole.label;
  const sourceDetail = document.createElement('p'); sourceDetail.textContent = sourceRole.detail;
  summary.append(sourceTitle, sourceDetail); body.append(summary);
  const reason = document.createElement('p'); reason.className = 'origin-reason'; reason.textContent = `판정 근거: ${symbol.origin.rule}`; body.append(reason);
  const anchorLabel = symbol.synthetic ? '확인한 사용 위치' : '판정 근거 위치';
  symbol.origin.anchors.forEach((item) => body.append(sourceLink(item, anchorLabel, `${item.file}:${item.startLine}`)));
  evidence.append(body); parent.append(evidence);
}

function renderSymbol(symbol: SymbolRecord): void {
  $('symbol-empty').hidden = true; const content = $('symbol-content'); content.hidden = false; content.replaceChildren();
  const sourceRole = originPresentation(symbol);
  const header = document.createElement('header'); header.className = 'symbol-header';
  const titleRow = document.createElement('div'); titleRow.className = 'symbol-title-row';
  const kind = document.createElement('span'); kind.className = 'kind-badge'; kind.textContent = kindLabels[symbol.kind];
  const origin = document.createElement('span'); origin.className = `origin-badge ${sourceRole.className}`; origin.textContent = sourceRole.label;
  const confidence = document.createElement('span'); confidence.className = 'confidence-badge'; confidence.textContent = sourceRole.confidence;
  titleRow.append(kind, origin, confidence);
  const title = document.createElement('h2'); title.textContent = symbol.name;
  const signature = document.createElement('div'); signature.className = 'symbol-signature'; signature.textContent = compactDeclaration(symbol.signature || `${symbol.type} ${symbol.name}`);
  header.append(titleRow, title, signature); content.append(header);

  const basics = section('정의 및 타입'); const grid = document.createElement('dl'); grid.className = 'info-grid';
  const rows: Array<[string, string]> = symbol.kind === 'macro'
    ? [['분류', kindLabels[symbol.kind]], ['매크로 종류', symbol.macro?.functionLike ? '함수형 매크로' : '객체형 매크로'], ['유효 범위', symbol.scope]]
    : [['분류', kindLabels[symbol.kind]], ['데이터 타입', compactDeclaration(symbol.type)], ['유효 범위', symbol.scope]];
  if (!symbol.synthetic) {
    const location = symbol.definition ?? symbol.declaration;
    rows.push([symbol.definition ? '정의 위치' : '선언 위치', `${location.file}:${location.startLine}`]);
  }
  for (const [label, value] of rows) { const dt = document.createElement('dt'); dt.textContent = label; const dd = document.createElement('dd'); dd.textContent = value; grid.append(dt, dd); }
  basics.append(grid); appendMacroValue(basics, symbol);
  if (!symbol.synthetic) basics.append(sourceLink(symbol.definition ?? symbol.declaration, symbol.definition ? '정의로 이동' : '선언으로 이동'));
  if (symbol.resolvedType && !symbol.resolvedType.inferred) {
    const typeLink = sourceLink(symbol.resolvedType.range, `타입 정의로 이동 · ${symbol.resolvedType.name}`);
    typeLink.classList.add('type-definition-link');
    typeLink.addEventListener('dblclick', () => void selectSymbol(symbol.resolvedType!.symbolId, true));
    basics.append(typeLink);
  } else if (symbol.resolvedType?.inferred) {
    const unresolvedType = document.createElement('p'); unresolvedType.className = 'type-use-note';
    unresolvedType.textContent = `${symbol.resolvedType.name} 정의는 열린 프로젝트 밖에 있어, 아래 구성은 실제 멤버 사용 코드에서 복원했습니다.`;
    basics.append(unresolvedType);
  }
  appendTypeExplanation(basics, symbol); content.append(basics);

  // The semantic explanation is the primary learning aid, so keep it directly
  // beneath the compact definition/type block instead of burying it after evidence.
  appendSymbolAI(content, symbol);

  if (symbol.kind === 'function') appendFunctionContract(content, symbol);
  const visibleFields = symbol.fields.length ? symbol.fields : symbol.resolvedType?.fields ?? [];
  if (visibleFields.length) {
    const inferredType = !symbol.fields.length && symbol.resolvedType?.inferred;
    const enumValues = visibleFields.some((field) => field.type === 'enum 값');
    const label = symbol.fields.length
      ? (enumValues ? '열거 상수와 값' : symbol.kind === 'union' ? '공용체(Union) 멤버' : '구성 필드')
      : `${inferredType ? '코드에서 확인된 데이터 타입 구성' : '데이터 타입 구성'} · ${symbol.resolvedType!.name}`;
    const descriptions = state.symbolInsights.get(symbol.id)?.fieldDescriptions ?? {};
    const fields = section(label); fields.append(renderFields(visibleFields, descriptions)); content.append(fields);
  }

  if (symbol.kind === 'field' && symbol.containingType?.fields.length) {
    const context = symbol.containingType;
    const ownerLabel = context.owner ? `${context.owner} : ${context.name}` : context.name;
    const fields = section(`소속 데이터 구조 · ${ownerLabel}`);
    const selected = document.createElement('p'); selected.className = 'field-context-path';
    selected.textContent = `현재 선택 · ${context.path.join('.')}`;
    fields.append(selected);
    const descriptions = state.symbolInsights.get(context.symbolId)?.fieldDescriptions ?? {};
    fields.append(renderFields(context.fields, descriptions, '', context.path.join('.')));
    content.append(fields);
  }

  if (symbol.kind === 'function') {
    appendCallList(content, '호출자 (Callers)', symbol.callers);
    appendCallList(content, '호출 대상 (Callees)', symbol.calls);
    appendReferences(content, '참조 위치 (References)', symbol.references);
  } else if (symbol.kind === 'variable' || symbol.kind === 'parameter' || symbol.kind === 'field') {
    appendReferences(content, '값 변경 지점 (Writes)', symbol.references.filter((reference) => reference.kind === 'write'), true);
    appendReferences(content, '값 읽기 위치 (Reads)', symbol.references.filter((reference) => reference.kind === 'read'));
    appendReferences(content, '선언 및 기타 참조', symbol.references.filter((reference) => reference.kind !== 'write' && reference.kind !== 'read'));
  } else {
    appendReferences(content, '참조 위치 (References)', symbol.references);
  }
  if (symbol.limitations.length) { const caveat = document.createElement('div'); caveat.className = 'caveat'; caveat.textContent = symbol.limitations.join(' '); content.append(caveat); }
  appendOriginEvidence(content, symbol, sourceRole);

  updateExplainScope();
  ($<HTMLButtonElement>('create-quiz')).disabled = symbol.kind !== 'function';
  updateBreadcrumbs();
  if (!state.symbolInsights.has(symbol.id)) void loadSymbolInsight(symbol, true);
}

async function selectSymbol(id: string, jump = false): Promise<void> {
  const symbol = await guarded(() => window.codeTutor.getSymbol(id), '심볼 조회'); if (!symbol) return;
  state.currentSymbol = symbol; renderSymbol(symbol); updateFlowFocus(symbol);
  if (jump) await navigate(symbol.definition ?? symbol.declaration);
}

interface EditorToken {
  token: string;
  lineText: string;
}

function editorTokenAt(line: number, column: number): EditorToken | null {
  const model = editor.getModel();
  if (!model) return null;
  const lineText = model.getLineContent(line);
  const word = model.getWordAtPosition({ lineNumber: line, column });
  if (word?.word) return { token: word.word, lineText };
  const offset = Math.max(0, column - 1);
  const numericPattern = /(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)[uUlLfF]*/g;
  for (const match of lineText.matchAll(numericPattern)) {
    const start = match.index ?? -1;
    if (start >= 0 && offset >= start && offset <= start + match[0].length) return { token: match[0], lineText };
  }
  for (const operator of C_OPERATOR_TOKENS) {
    let start = lineText.indexOf(operator);
    while (start >= 0) {
      if (offset >= start && offset <= start + operator.length) return { token: operator, lineText };
      start = lineText.indexOf(operator, start + 1);
    }
  }
  if (/^\s*#/.test(lineText) && offset <= lineText.indexOf('#') + 1) return { token: '#', lineText };
  return null;
}

function renderCTokenExplanation(explanation: CTokenExplanation, line: number): void {
  state.currentSymbol = null;
  $('symbol-empty').hidden = true;
  const content = $('symbol-content'); content.hidden = false; content.replaceChildren();
  const header = document.createElement('div'); header.className = 'language-token-header';
  const badges = document.createElement('div'); badges.className = 'symbol-badges';
  const kind = document.createElement('span'); kind.className = 'badge kind'; kind.textContent = 'C 공통 문법';
  const cached = document.createElement('span'); cached.className = 'badge confidence'; cached.textContent = '즉시 설명 · AI 호출 없음';
  badges.append(kind, cached);
  const title = document.createElement('h2'); title.textContent = explanation.title;
  const signature = document.createElement('code'); signature.textContent = explanation.token;
  header.append(badges, title, signature); content.append(header);

  const meaning = section('핵심 의미');
  const summary = document.createElement('p'); summary.className = 'token-summary'; summary.textContent = explanation.summary;
  meaning.append(summary); content.append(meaning);

  const reading = section('코드에서 읽는 방법');
  const list = document.createElement('ul'); list.className = 'token-details';
  for (const detail of explanation.details) { const item = document.createElement('li'); item.textContent = detail; list.append(item); }
  reading.append(list);
  if (explanation.context) { const context = document.createElement('div'); context.className = 'token-context'; context.textContent = explanation.context; reading.append(context); }
  if (explanation.example) { const example = document.createElement('pre'); example.className = 'token-example'; example.textContent = explanation.example; reading.append(example); }
  content.append(reading);

  if (state.currentFile) {
    const location = section('현재 위치');
    location.append(sourceLink({ file: state.currentFile, startLine: line, startColumn: 1, endLine: line, endColumn: 1 }, '코드로 이동', `${state.currentFile}:${line}`));
    content.append(location);
  }
  const note = document.createElement('div'); note.className = 'grammar-cache-note';
  note.textContent = '이 설명은 프로젝트와 무관한 C 공통 지식으로 한 번만 내장되어 모든 동일 토큰에 재사용됩니다. 백그라운드 AI 분석 순서를 차지하지 않습니다.';
  content.append(note);
  updateExplainScope(); updateBreadcrumbs(); $<HTMLButtonElement>('create-quiz').disabled = true;
}

async function inspectAt(line: number, column: number): Promise<void> {
  if (!state.currentFile) return;
  const selected = editorTokenAt(line, column); if (!selected || isDirectNumericLiteral(selected.token)) return;
  const request = ++inspectionSequence;
  const identifier = /^[A-Za-z_]\w*$/.test(selected.token);
  const explanation = describeCToken(selected.token, selected.lineText, column);
  const isLanguageSyntax = isCReservedWord(selected.token)
    || !identifier
    || explanation?.category === 'C 문법'
    || explanation?.category === '전처리 지시문'
    || explanation?.category === '포함 헤더';
  if (explanation && isLanguageSyntax) {
    renderCTokenExplanation(explanation, line);
    return;
  }
  const symbol = identifier
    ? await guarded(() => window.codeTutor.getSymbolAt({ file: state.currentFile!, line, column, word: selected.token }), '심볼 조회')
    : null;
  if (request !== inspectionSequence) return;
  if (symbol) { state.currentSymbol = symbol; renderSymbol(symbol); updateFlowFocus(symbol, { file: state.currentFile, line, column }); }
  else if (explanation) renderCTokenExplanation(explanation, line);
}

async function goToDefinitionAt(line: number, column: number): Promise<void> {
  if (!state.currentFile) return;
  const word = editor.getModel()?.getWordAtPosition({ lineNumber: line, column });
  if (!word) return;
  const symbol = await guarded(() => window.codeTutor.getSymbolAt({ file: state.currentFile!, line, column, word: word.word }), '정의 이동');
  if (!symbol) { toast(`${word.word}: 프로젝트 내부 정의를 찾지 못했습니다.`, true); return; }
  state.currentSymbol = symbol; renderSymbol(symbol); updateFlowFocus(symbol, { file: state.currentFile, line, column });
  if (symbol.synthetic) toast(`${symbol.name}: 프로젝트 내부 정의가 없어 확인된 사용 위치로 이동합니다.`);
  await navigate(symbol.definition ?? symbol.declaration);
}

function functionIdForSymbol(symbol: SymbolRecord, at?: { file: string; line: number; column: number }): string | null {
  if (symbol.kind === 'function') return symbol.id;
  const sourceFile = symbol.definition?.file ?? symbol.declaration.file;
  const contextualOwner = at
    ? symbol.references.find((reference) => reference.range.file === at.file
      && at.line >= reference.range.startLine && at.line <= reference.range.endLine)?.container
    : undefined;
  const ownerName = contextualOwner ?? symbol.scope;
  return state.snapshot?.symbols.find((candidate) => candidate.kind === 'function' && candidate.name === ownerName && candidate.file === sourceFile)?.id
    ?? state.snapshot?.symbols.find((candidate) => candidate.kind === 'function' && candidate.name === ownerName)?.id
    ?? null;
}

function updateFlowLocation(location: FlowLocation | null): void {
  state.flowLocation = location;
  const host = $('flow-location'); host.replaceChildren();
  const icon = document.createElement('span'); icon.className = 'flow-location-icon'; icon.textContent = location ? String(location.stageIndex + 1).padStart(2, '0') : '◎';
  const copy = document.createElement('div'); const label = document.createElement('small'); label.textContent = '현재 코드 위치';
  const value = document.createElement('strong');
  if (location) value.textContent = `${location.stageTitle} · ${location.node.name}`;
  else if (state.graphFocusId) value.textContent = '현재 심볼은 표시된 실행 개요 범위 밖에 있습니다.';
  else value.textContent = '코드에서 함수나 변수를 선택하세요';
  copy.append(label, value); host.append(icon, copy);
  $<HTMLButtonElement>('flow-locate').disabled = !state.graphFocusId;
}

function renderCurrentFlow(): void {
  if (!state.graph) return;
  const control = renderFlowOverview($('flow-canvas'), state.graph, state.graphFocusId ?? undefined, (id) => void selectSymbol(id, true), state.projectInsight);
  state.graphReset = control.reset;
  updateFlowLocation(control.location);
}

function updateFlowFocus(symbol: SymbolRecord, at?: { file: string; line: number; column: number }): void {
  state.graphFocusId = functionIdForSymbol(symbol, at);
  renderCurrentFlow();
  if (state.graphFocusId && state.graph && !state.flowLocation) {
    const focusId = state.graphFocusId;
    window.setTimeout(async () => {
      if (state.graphFocusId !== focusId || state.flowLocation) return;
      const owner = await window.codeTutor.getSymbol(focusId);
      if (!owner || owner.kind !== 'function' || state.graphFocusId !== focusId) return;
      ensureFlowRootOption(owner);
      $<HTMLSelectElement>('flow-root').value = owner.id;
      await refreshGraph(owner.id);
    }, 180);
  }
}

function ensureFlowRootOption(symbol: SymbolRecord): void {
  const select = $<HTMLSelectElement>('flow-root');
  if ([...select.options].some((option) => option.value === symbol.id)) return;
  const option = document.createElement('option'); option.value = symbol.id; option.textContent = `${symbol.name}부터 보기`;
  select.append(option);
}

async function refreshGraph(rootId?: string): Promise<void> {
  if (!state.snapshot) return;
  const graph = await guarded(() => window.codeTutor.getGraph({ rootId, limit: 100 }), '실행 개요 분석'); if (!graph) return;
  state.graph = graph;
  renderCurrentFlow();
  $('flow-caveat').textContent = `${graph.limitations.join(' ')}${graph.truncated ? ' 큰 프로젝트는 대표 진입점과 그 하위 호출을 우선해 러프한 개요만 표시합니다.' : ''}`;
  const select = $<HTMLSelectElement>('flow-root');
  if (select.options.length <= 1) {
    graph.roots.slice(0, 12).forEach((id) => {
      const symbol = state.snapshot?.symbols.find((item) => item.id === id); if (!symbol) return;
      const option = document.createElement('option'); option.value = id; option.textContent = `${symbol.name} · ${symbol.file}:${symbol.line}`; select.append(option);
    });
  }
}

async function locateCurrentFlow(): Promise<void> {
  if (!state.graphFocusId) return;
  renderCurrentFlow();
  if (state.flowLocation) return;
  const select = $<HTMLSelectElement>('flow-root'); select.value = '';
  await refreshGraph();
  if (state.flowLocation) return;
  const owner = await window.codeTutor.getSymbol(state.graphFocusId);
  if (!owner || owner.kind !== 'function') return;
  ensureFlowRootOption(owner); select.value = owner.id;
  await refreshGraph(owner.id);
}

function selectedAI(): Pick<AIRequest, 'engine' | 'model' | 'effort' | 'fast'> {
  return {
    engine: $<HTMLSelectElement>('ai-engine').value as AIRequest['engine'],
    model: $<HTMLSelectElement>('ai-model').value || 'default',
    effort: $<HTMLSelectElement>('ai-effort').value as AIRequest['effort'],
    fast: $<HTMLInputElement>('ai-fast').checked,
  };
}

function selectedCommentAI(): Pick<AIRequest, 'engine' | 'model' | 'effort' | 'fast'> {
  return {
    engine: $<HTMLSelectElement>('comment-ai-engine').value as AIRequest['engine'],
    model: $<HTMLSelectElement>('comment-ai-model').value || 'gpt-5.6-sol',
    effort: $<HTMLSelectElement>('comment-ai-effort').value as AIRequest['effort'],
    fast: $<HTMLInputElement>('comment-ai-fast').checked,
  };
}

function updateModelOptions(preferredModel?: string): void {
  const engine = $<HTMLSelectElement>('ai-engine').value;
  const info = state.engines.find((item) => item.engine === engine);
  const select = $<HTMLSelectElement>('ai-model'); const previous = preferredModel ?? select.value;
  select.replaceChildren();
  for (const model of info?.models ?? [{ id: 'default', label: 'CLI 기본 모델', efforts: ['medium'] }]) {
    const option = document.createElement('option'); option.value = model.id; option.textContent = model.label; option.title = model.description ?? model.id; select.append(option);
  }
  const values = [...select.options].map((option) => option.value);
  select.value = values.includes(previous) ? previous : values.includes('default') ? 'default' : values[0] ?? 'default';
  updateEffortOptions();
  $('fast-label').hidden = !info?.supportsFast;
  $<HTMLInputElement>('ai-fast').disabled = !info?.supportsFast;
}

function updateEffortOptions(): void {
  const engine = $<HTMLSelectElement>('ai-engine').value;
  const info = state.engines.find((item) => item.engine === engine);
  const modelId = $<HTMLSelectElement>('ai-model').value || 'default';
  const efforts = info?.models.find((model) => model.id === modelId)?.efforts ?? info?.efforts ?? ['medium'];
  const select = $<HTMLSelectElement>('ai-effort'); const previous = select.value; select.replaceChildren();
  for (const effort of efforts) { const option = document.createElement('option'); option.value = effort; option.textContent = effort; select.append(option); }
  select.value = efforts.includes(previous) ? previous : efforts.includes('medium') ? 'medium' : efforts[0] ?? 'medium';
}

function updateCommentEffortOptions(preferredEffort?: AIRequest['effort']): void {
  const engine = $<HTMLSelectElement>('comment-ai-engine').value;
  const info = state.engines.find((item) => item.engine === engine);
  const modelId = $<HTMLSelectElement>('comment-ai-model').value || 'gpt-5.6-sol';
  const efforts = info?.models.find((model) => model.id === modelId)?.efforts ?? info?.efforts ?? ['medium'];
  const select = $<HTMLSelectElement>('comment-ai-effort');
  const previous = preferredEffort ?? select.value as AIRequest['effort'];
  select.replaceChildren();
  for (const effort of efforts) {
    const option = document.createElement('option'); option.value = effort; option.textContent = effort; select.append(option);
  }
  select.value = efforts.includes(previous) ? previous : efforts.includes('medium') ? 'medium' : efforts[0] ?? 'medium';
}

function updateCommentAIStatusNote(): void {
  const engine = $<HTMLSelectElement>('comment-ai-engine').selectedOptions[0]?.textContent ?? 'Codex';
  const model = $<HTMLSelectElement>('comment-ai-model').selectedOptions[0]?.textContent ?? 'GPT-5.6-Sol';
  const effort = $<HTMLSelectElement>('comment-ai-effort').value;
  const fast = $<HTMLInputElement>('comment-ai-fast').checked ? ' · FAST' : '';
  $('comment-ai-note').textContent = `이번 주석 생성: ${engine} · ${model} · ${effort}${fast}`;
}

function updateCommentModelOptions(preferredModel?: string, preferredEffort?: AIRequest['effort']): void {
  const engine = $<HTMLSelectElement>('comment-ai-engine').value;
  const info = state.engines.find((item) => item.engine === engine);
  const select = $<HTMLSelectElement>('comment-ai-model');
  const previous = (preferredModel ?? select.value) || (engine === 'codex' ? 'gpt-5.6-sol' : 'default');
  select.replaceChildren();
  for (const model of info?.models ?? [{ id: 'default', label: 'CLI 기본 모델', efforts: ['medium'] }]) {
    const option = document.createElement('option'); option.value = model.id; option.textContent = model.label; option.title = model.description ?? model.id; select.append(option);
  }
  if (previous && ![...select.options].some((option) => option.value === previous)) {
    const configured = document.createElement('option'); configured.value = previous; configured.textContent = previous; configured.title = '저장된 주석 모델 설정'; select.append(configured);
  }
  const values = [...select.options].map((option) => option.value);
  select.value = values.includes(previous) ? previous : values.includes('default') ? 'default' : values[0] ?? 'default';
  updateCommentEffortOptions(preferredEffort);
  $('comment-ai-fast-label').hidden = !info?.supportsFast;
  $<HTMLInputElement>('comment-ai-fast').disabled = !info?.supportsFast;
  updateCommentAIStatusNote();
}

type ExplainScope = 'project' | 'symbol' | 'selection';

function updateExplainScope(): void {
  const select = $<HTMLSelectElement>('explain-scope');
  const symbolOption = [...select.options].find((option) => option.value === 'symbol');
  const selectionOption = [...select.options].find((option) => option.value === 'selection');
  if (symbolOption) {
    symbolOption.disabled = !state.currentSymbol;
    symbolOption.textContent = state.currentSymbol ? `현재 심볼 · ${state.currentSymbol.name}` : '현재 심볼';
  }
  if (selectionOption) {
    selectionOption.disabled = !state.currentSelection;
    selectionOption.textContent = state.currentSelection
      ? `선택 영역 · ${state.currentSelection.file}:${state.currentSelection.startLine}-${state.currentSelection.endLine}`
      : '선택 영역';
  }
  const selected = select.selectedOptions[0];
  if (selected?.disabled) select.value = 'project';
  const scope = select.value as ExplainScope;
  const target = scope === 'symbol' && state.currentSymbol
    ? `${kindLabels[state.currentSymbol.kind]} · ${state.currentSymbol.name}`
    : scope === 'selection' && state.currentSelection
      ? `${state.currentSelection.file}:${state.currentSelection.startLine}-${state.currentSelection.endLine}`
      : '프로젝트 전체 구조와 실행 방식';
  $('explain-target').textContent = target;
  $<HTMLButtonElement>('generate-explanation').disabled = !state.snapshot
    || (scope === 'symbol' && !state.currentSymbol)
    || (scope === 'selection' && !state.currentSelection);
}

async function persistAISettings(): Promise<void> {
  const next = await window.codeTutor.saveSettings({ ...selectedAI(), autoAnalyzeSymbols: $<HTMLInputElement>('auto-symbol-analysis').checked });
  state.settings = next;
}

async function persistCommentAISettings(): Promise<void> {
  const selection = selectedCommentAI();
  const next = await window.codeTutor.saveSettings({
    commentEngine: selection.engine,
    commentModel: selection.model,
    commentEffort: selection.effort,
    commentFast: selection.fast,
  });
  state.settings = next;
  updateCommentAIStatusNote();
}

function renderAnalysisStatus(): void {
  const host = $('semantic-progress'); const current = state.analysisStatus;
  if ((!current || current.state === 'idle') && !state.snapshot) { host.hidden = true; host.replaceChildren(); return; }
  const status: BackgroundAnalysisStatus = current && current.state !== 'idle' ? current : {
    state: 'idle', model: '전용 경량 모델', effort: 'low', fast: true,
    total: 0, completed: 0, cached: 0, failed: 0, profileReady: false,
    message: '자동 분석을 기다리고 있습니다. 필요하면 전체 재분석을 시작할 수 있습니다.',
  };
  host.hidden = false; host.replaceChildren(); host.className = `semantic-progress ${status.state}`;
  const top = document.createElement('div');
  const label = document.createElement('span');
  label.textContent = status.state === 'idle' ? 'AI 분석 대기' : status.state === 'disabled' ? '사전 분석 꺼짐' : status.state === 'done' ? '전체 심볼 준비됨' : status.state === 'error' ? '사전 분석 일부 실패' : '사용자 코드 우선 분석';
  const actions = document.createElement('div'); actions.className = 'semantic-progress-actions';
  const model = document.createElement('code'); model.textContent = `${status.model} · ${status.effort}${status.fast ? ' · FAST' : ''}`;
  const restart = document.createElement('button'); restart.className = 'ghost semantic-restart'; restart.textContent = '전체 재분석';
  restart.title = '저장된 프로젝트 목적과 src 심볼 설명을 지우고 처음부터 다시 분석합니다.';
  restart.addEventListener('click', () => void restartAllAnalysis(restart));
  actions.append(model, restart); top.append(label, actions); host.append(top);
  if (status.state !== 'disabled' && status.state !== 'idle') {
    const progress = document.createElement('div'); progress.className = 'semantic-progress-track';
    const fill = document.createElement('span'); fill.style.width = `${status.total ? Math.min(100, (status.completed + status.failed) / status.total * 100) : status.profileReady ? 100 : 4}%`; progress.append(fill); host.append(progress);
  }
  const detail = document.createElement('small');
  detail.textContent = status.state === 'disabled'
    ? status.message
    : status.state === 'idle'
      ? status.message
    : `${status.completed.toLocaleString('ko-KR')}/${status.total.toLocaleString('ko-KR')} · ${status.message}`;
  host.append(detail);
}

async function restartAllAnalysis(button?: HTMLButtonElement): Promise<void> {
  if (!state.snapshot) return;
  if (!window.confirm('저장된 프로젝트 목적과 src 심볼 AI 설명을 지우고 처음부터 다시 분석할까요?\n코드와 채팅·노트는 변경되지 않습니다.')) return;
  if (button) button.disabled = true;
  state.symbolInsights.clear();
  state.symbolSummaryJobs.clear();
  state.projectInsight = null;
  if (state.currentSymbol) renderSymbol(state.currentSymbol);
  const status = await guarded(() => window.codeTutor.restartBackgroundAnalysis(), '전체 AI 재분석');
  if (!status) { if (button) button.disabled = false; return; }
  state.analysisStatus = status; renderAnalysisStatus(); renderCurrentFlow();
  toast('저장된 AI 분석을 초기화하고 전체 재분석을 시작했습니다.');
}

async function refreshProjectInsight(): Promise<void> {
  const insight = await guarded(() => window.codeTutor.getProjectInsight(), '프로젝트 목적 조회');
  state.projectInsight = insight;
  renderCurrentFlow();
}

async function startBackgroundAnalysis(): Promise<void> {
  const status = await guarded(() => window.codeTutor.startBackgroundAnalysis(), 'src 전체 심볼 사전 분석');
  if (!status) return;
  state.analysisStatus = status; renderAnalysisStatus();
  if (status.profileReady) await refreshProjectInsight();
}

async function handleBackgroundAnalysis(status: BackgroundAnalysisStatus): Promise<void> {
  const profileBecameReady = status.profileReady && !state.analysisStatus?.profileReady;
  state.analysisStatus = status; renderAnalysisStatus();
  if (profileBecameReady || (status.profileReady && !state.projectInsight)) await refreshProjectInsight();
  const symbol = state.currentSymbol;
  if (!symbol || state.symbolInsights.has(symbol.id)) return;
  const file = (symbol.definition ?? symbol.declaration).file;
  if (status.currentFile === file || status.state === 'done' || status.state === 'error') await loadSymbolInsight(symbol, true);
}

async function showExplanation(job: AIJob): Promise<void> {
  const output = $('explain-output');
  if (job.state === 'error') { $('explain-status').className = 'result-status'; $('explain-status').textContent = `오류: ${job.error}`; return; }
  if (job.state !== 'done') return;
  const validations = await window.codeTutor.validateAnchors(job.output);
  await renderGroundedMarkdown(output, job.output, validations, (range) => void navigate(range), (document) => void openReferenceAnchor(document));
  const valid = validations.filter((item) => item.valid).length;
  const badge = $('explain-evidence'); badge.hidden = false; badge.textContent = `근거 확인 ${valid}/${validations.length} · 유효한 설명 문장을 누르면 코드로 이동합니다.`;
  $('explain-status').className = 'result-status'; $('explain-status').textContent = '해설 완료';
}

async function startExplanation(scopeOverride?: ExplainScope): Promise<void> {
  const scopeSelect = $<HTMLSelectElement>('explain-scope');
  if (scopeOverride) scopeSelect.value = scopeOverride;
  updateExplainScope();
  const scope = scopeSelect.value as ExplainScope;
  if (!state.snapshot) return;
  if (scope === 'symbol' && !state.currentSymbol) return;
  if (scope === 'selection' && !state.currentSelection) return;
  activateTab('explain');
  $('explain-output').textContent = ''; $('explain-status').className = 'result-status running'; $('explain-status').textContent = '해설 생성 중…'; $('explain-evidence').hidden = true;
  const symbolId = scope === 'symbol' ? state.currentSymbol!.id : scope === 'selection' ? state.currentSelection?.symbolId : undefined;
  const selection = scope === 'selection' ? state.currentSelection ?? undefined : undefined;
  const job = await guarded(() => window.codeTutor.startAI({ kind: 'explain', symbolId, selection, ...selectedAI() }), 'AI 해설');
  if (!job) return; state.activeExplainJob = job.id; state.jobs.set(job.id, job); renderJobs(); if (job.state === 'done') await showExplanation(job);
}

function jobStateLabel(job: AIJob): string {
  return ({ queued: '대기', running: '실행 중', done: '완료', error: '오류', cancelled: '취소됨' } as const)[job.state];
}

function renderJobs(): void {
  const jobs = [...state.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = jobs.filter((job) => job.state === 'queued' || job.state === 'running'); $('jobs-count').textContent = String(active.length);
  const list = $('jobs-list'); list.replaceChildren();
  if (!jobs.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'AI 작업이 없습니다.'; list.append(empty); return; }
  jobs.slice(0, 15).forEach((job) => {
    const row = document.createElement('div'); row.className = 'job-row';
    const info = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = ({
      explain: '코드 해설', chat: '코드 질문', quiz: '이해도 체크', summary: 'AI 분석', comment: 'AI 주석 생성', catalog: 'src 전체 심볼 분석',
    } as const)[job.kind];
    const small = document.createElement('small'); small.innerHTML = `${job.engine} · ${job.model} · <span class="job-state ${job.state}">${jobStateLabel(job)}</span>`; info.append(strong, small); row.append(info);
    if (job.state === 'queued' || job.state === 'running') { const cancel = document.createElement('button'); cancel.className = 'ghost'; cancel.textContent = '취소'; cancel.addEventListener('click', () => void window.codeTutor.cancelAI(job.id)); row.append(cancel); }
    list.append(row);
  });
}

async function handleJobEvent(event: AIJobEvent): Promise<void> {
  state.jobs.set(event.job.id, event.job); renderJobs();
  if (event.job.kind === 'summary' && event.job.symbolId) {
    state.symbolSummaryJobs.set(event.job.symbolId, event.job.id);
    await showSymbolSummary(event.job);
  }
  if (event.job.kind === 'catalog') {
    const linkedSymbols = [...state.symbolSummaryJobs.entries()].filter(([, jobId]) => jobId === event.job.id).map(([symbolId]) => symbolId);
    for (const symbolId of linkedSymbols) {
      await showSymbolSummary(event.job, symbolId);
      if (event.type === 'updated' && event.job.state === 'error' && state.currentSymbol?.id === symbolId) {
        $('symbol-ai-status').className = 'result-status'; $('symbol-ai-status').textContent = `분석 오류: ${event.job.error}`;
      }
    }
  }
  if (event.job.id === state.activeExplainJob) {
    if (event.type === 'chunk') { $('explain-output').textContent = event.job.output; }
    if (event.type === 'updated' && ['done', 'error', 'cancelled'].includes(event.job.state)) await showExplanation(event.job);
  }
  if (event.job.kind === 'chat') {
    if (event.job.error && event.type === 'updated') toast(event.job.error, true);
    if (event.job.chatId === state.currentChatId) await renderChat(await window.codeTutor.getChat(event.job.chatId));
    if (event.type === 'updated' && ['done', 'error', 'cancelled'].includes(event.job.state)) await refreshChats(event.job.chatId);
  }
  if (event.job.kind === 'quiz' && event.type === 'updated' && ['done', 'error'].includes(event.job.state)) {
    if (event.job.error) toast(event.job.error, true); else toast('이해도 체크 3문항을 만들었습니다.');
    await refreshQuizzes();
  }
  if (event.job.kind === 'comment' && event.job.id === state.activeCommentJob) {
    const preview = extractCommentCode(event.job.output);
    const batch = state.commentBatch;
    if (batch) {
      const completed = batch.outputs.slice(0, batch.activeIndex).join('\n');
      $<HTMLTextAreaElement>('comment-preview').value = [completed, preview].filter(Boolean).join('\n');
      if (event.job.state === 'error' || event.job.state === 'cancelled') {
        $('comment-status').className = 'result-status';
        $('comment-status').textContent = event.job.state === 'cancelled' ? '주석 생성을 취소했습니다.' : `오류: ${event.job.error}`;
        state.activeCommentJob = null; state.commentBatch = null;
        setCommentGenerationRunning(false);
      } else if (event.type === 'updated' && event.job.state === 'done') {
        batch.outputs[batch.activeIndex] = preview;
        if (batch.activeIndex + 1 < batch.chunks.length) {
          void startCommentBatchChunk(batch.activeIndex + 1);
        } else {
          state.commentOutput = batch.outputs.join('\n');
          $<HTMLTextAreaElement>('comment-preview').value = state.commentOutput;
          $('comment-status').className = 'result-status';
          $('comment-status').textContent = `생성 완료 · ${batch.chunks.length.toLocaleString('ko-KR')}개 구간을 합쳤습니다. 내용을 검토한 뒤 적용하세요.`;
          state.activeCommentJob = null; state.commentBatch = null;
          setCommentGenerationRunning(false);
          $<HTMLButtonElement>('comment-apply').disabled = false;
        }
      }
    } else {
      state.commentOutput = event.job.output;
      $<HTMLTextAreaElement>('comment-preview').value = preview;
      if (event.job.state === 'error') {
        $('comment-status').className = 'result-status'; $('comment-status').textContent = `오류: ${event.job.error}`;
      } else if (event.job.state === 'done') {
        $('comment-status').className = 'result-status'; $('comment-status').textContent = '생성 완료 · 내용을 검토한 뒤 적용하세요.';
        $<HTMLButtonElement>('comment-apply').disabled = false;
      }
    }
  }
}

function extractCommentCode(output: string): string {
  const fenced = output.match(/```(?:c|cpp|h)?\s*\r?\n([\s\S]*?)```/i)?.[1] ?? output;
  return fenced.replace(/\r\n/g, '\n').trimEnd();
}

async function currentSelection(): Promise<AISelection | null> {
  const selection = editor.getSelection(); if (!selection || selection.isEmpty() || !state.currentFile) return null;
  const text = editor.getModel()?.getValueInRange(selection) ?? ''; if (!text.trim()) return null;
  return { file: state.currentFile, startLine: selection.startLineNumber, endLine: selection.endLineNumber, text, symbolId: state.currentSymbol?.id, codeHash: await sha256(text) };
}

function updateQuestionContext(): void {
  const context = state.questionContext;
  const button = $<HTMLButtonElement>('chat-context'); button.replaceChildren();
  const label = document.createElement('span'); label.textContent = '질문 범위';
  const value = document.createElement('strong');
  value.textContent = context ? `${context.file}:${context.startLine}-${context.endLine}` : '프로젝트 전체';
  button.append(label, value);
  button.disabled = !context;
  button.title = context ? '선택한 코드로 이동' : 'AI가 프로젝트 전체를 탐색해 답변합니다.';
  $('clear-chat-context').hidden = !context;
}

function askWholeProject(): void {
  state.questionContext = null;
  updateQuestionContext();
  activateTab('chat');
  $<HTMLTextAreaElement>('chat-input').focus();
}

async function askWithCurrentSelection(): Promise<void> {
  const selection = await currentSelection();
  if (!selection) { toast('질문할 코드 영역을 먼저 드래그해 선택하세요.', true); return; }
  state.currentSelection = selection;
  state.questionContext = selection;
  updateQuestionContext();
  updateExplainScope();
  activateTab('chat');
  $<HTMLTextAreaElement>('chat-input').focus();
}

async function refreshChats(selectId?: string): Promise<void> {
  const chats = await guarded(() => window.codeTutor.listChats(), '대화 기록'); if (!chats) return;
  const select = $<HTMLSelectElement>('chat-history'); select.replaceChildren(); const base = document.createElement('option'); base.value = ''; base.textContent = '대화 기록'; select.append(base);
  chats.forEach((chat) => { const option = document.createElement('option'); option.value = chat.id; option.textContent = `${chat.stale ? '⚠ ' : ''}${chat.title}`; select.append(option); });
  const requested = selectId ?? state.currentChatId ?? chats[0]?.id;
  const target = requested ? chats.find((chat) => chat.id === requested) : undefined;
  if (target) { select.value = target.id; await renderChat(await window.codeTutor.getChat(target.id)); }
  else if (!chats.length) await renderChat(null);
}

function chatJobs(chatId: string | null): AIJob[] {
  if (!chatId) return [];
  return [...state.jobs.values()].filter((job) => job.kind === 'chat' && job.chatId === chatId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function activeChatJob(chatId: string | null): AIJob | null {
  return chatJobs(chatId).find((job) => job.state === 'queued' || job.state === 'running') ?? null;
}

function updateChatComposer(chatId = state.currentChatId): void {
  const active = activeChatJob(chatId);
  const send = $<HTMLButtonElement>('send-chat');
  send.disabled = Boolean(active); send.textContent = active ? '답변 중' : '전송';
  const status = $('chat-status');
  status.hidden = !active;
  status.className = `chat-status${active ? ' running' : ''}`;
  status.textContent = active
    ? active.state === 'queued'
      ? '요청이 대기 중입니다. 입력란에 다음 질문을 미리 작성할 수 있으며, 현재 답변이 끝나면 전송할 수 있습니다.'
      : '프로젝트 코드를 확인하며 답변을 작성하고 있습니다. 입력란은 다음 질문의 초안으로 사용할 수 있습니다.'
    : '';
}

async function renderChat(chat: ChatThread | null): Promise<void> {
  const thread = $('chat-thread'); thread.replaceChildren(); $('chat-stale').hidden = !chat?.stale;
  state.questionContext = chat?.anchor ?? null; updateQuestionContext();
  const previousChatId = state.currentChatId;
  if (!chat) {
    state.currentChatId = null;
    if (state.snapshot && previousChatId !== null) void window.codeTutor.saveUiState({ lastChatId: '' });
    const empty = document.createElement('div'); empty.className = 'empty-state small'; empty.innerHTML = '<p>프로젝트 전체를 기준으로 새 질문을 시작하세요.</p>'; thread.append(empty);
    updateChatComposer(); return;
  }
  state.currentChatId = chat.id;
  if (state.snapshot && previousChatId !== chat.id) void window.codeTutor.saveUiState({ lastChatId: chat.id });
  for (const message of chat.messages) {
    const bubble = document.createElement('div'); bubble.className = `message ${message.role}`;
    if (message.role === 'user') bubble.textContent = message.content;
    else await renderGroundedMarkdown(bubble, message.content, await window.codeTutor.validateAnchors(message.content), (range) => void navigate(range), (document) => void openReferenceAnchor(document));
    thread.append(bubble);
  }
  const active = activeChatJob(chat.id);
  if (active) {
    const bubble = document.createElement('div'); bubble.className = 'message assistant pending';
    const heading = document.createElement('div'); heading.className = 'pending-heading';
    const spinner = document.createElement('span'); spinner.className = 'inline-spinner';
    const label = document.createElement('strong'); label.textContent = active.state === 'queued' ? '답변 준비 중' : '답변 작성 중';
    heading.append(spinner, label); bubble.append(heading);
    const draft = document.createElement('div'); draft.className = 'assistant-draft';
    draft.textContent = active.output.trim() || (active.state === 'queued' ? '앞선 작업이 끝나기를 기다리고 있습니다.' : '관련 코드와 호출 관계를 확인하고 있습니다…');
    bubble.append(draft); thread.append(bubble);
  } else {
    const failed = chatJobs(chat.id).find((job) => job.state === 'error' || job.state === 'cancelled');
    if (failed && chat.messages.at(-1)?.role === 'user') {
      const bubble = document.createElement('div'); bubble.className = 'message assistant failed';
      bubble.textContent = failed.state === 'cancelled' ? '답변 생성이 취소되었습니다.' : `답변을 생성하지 못했습니다: ${failed.error ?? '알 수 없는 오류'}`;
      thread.append(bubble);
    }
  }
  updateChatComposer(chat.id);
  thread.scrollTop = thread.scrollHeight;
}

async function sendChat(): Promise<void> {
  const input = $<HTMLTextAreaElement>('chat-input'); const question = input.value.trim(); if (!question) return;
  if (activeChatJob(state.currentChatId)) { toast('현재 답변이 끝난 뒤 다음 질문을 전송할 수 있습니다.', true); return; }
  const context = state.questionContext;
  const job = await guarded(() => window.codeTutor.startAI({ kind: 'chat', question, chatId: state.currentChatId ?? undefined, symbolId: context?.symbolId, selection: context ?? undefined, ...selectedAI() }), '질문 전송');
  if (!job) return; input.value = ''; state.jobs.set(job.id, job); renderJobs(); await refreshChats(job.chatId);
}

function renderReference(info: ReferenceFolderInfo): void {
  state.reference = info;
  $('reference-count').textContent = String(info.documents.length);
  $('reference-path').textContent = info.folderPath ?? '지정된 폴더가 없습니다.';
  $('reference-summary').textContent = info.folderPath
    ? `${info.documents.length}개 문서 · ${info.indexedPages.toLocaleString('ko-KR')}페이지/텍스트 구간을 AI 근거 검색에 사용합니다.`
    : '데이터시트 PDF와 텍스트 문서를 페이지 단위로 검색합니다.';
  $<HTMLButtonElement>('reference-clear').disabled = !info.folderPath;
  const host = $('reference-documents'); host.replaceChildren();
  if (!info.documents.length) {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = info.folderPath ? '지원되는 문서를 찾지 못했습니다.' : '폴더를 지정하면 문서 목록이 표시됩니다.'; host.append(empty);
    return;
  }
  for (const referenceDocument of info.documents.slice(0, 80)) {
    const row = document.createElement('div'); row.className = 'reference-document';
    const name = document.createElement('strong'); name.textContent = referenceDocument.relativePath; name.title = referenceDocument.relativePath;
    const meta = document.createElement('small'); meta.textContent = `${referenceDocument.kind.toLocaleUpperCase('en-US')} · ${referenceDocument.pages}p`;
    row.append(name, meta); host.append(row);
  }
}

async function refreshReference(): Promise<void> {
  const info = await guarded(() => window.codeTutor.getReferenceFolder(), '레퍼런스 정보');
  if (info) renderReference(info);
}

async function pickReferenceFolder(): Promise<void> {
  if (!state.snapshot) { toast('레퍼런스를 연결할 프로젝트를 먼저 여세요.', true); return; }
  $('reference-popover').hidden = false;
  $('reference-summary').textContent = '문서의 페이지 텍스트를 인덱싱하고 있습니다…';
  const info = await guarded(() => window.codeTutor.pickReferenceFolder(), '레퍼런스 폴더 지정');
  if (info) { renderReference(info); toast(`${info.documents.length}개 레퍼런스 문서를 연결했습니다.`); }
  else await refreshReference();
}

async function exportLearningNotes(): Promise<void> {
  if (!state.snapshot) { toast('내보낼 프로젝트 학습 노트가 없습니다.', true); return; }
  const result = await window.codeTutor.exportNotes();
  if (!result.canceled) toast(`학습 노트를 저장했습니다: ${result.path}`);
}

function handleAppCommand(command: AppCommand): void {
  if (command === 'import-project') { void openProject(); return; }
  if (command === 'refresh-active-project') { void refreshActiveProject(); return; }
  if (command === 'close-active-project') {
    if (!state.snapshot) { toast('닫을 프로젝트가 없습니다.', true); return; }
    void closeProject(state.snapshot.rootPath); return;
  }
  if (command === 'pick-reference-folder') { void pickReferenceFolder(); return; }
  if (command === 'export-notes') { void exportLearningNotes(); return; }
  if (command === 'focus-projects') {
    const target = document.querySelector<HTMLElement>('.project-item.active') ?? $<HTMLButtonElement>('open-project');
    target.focus(); target.scrollIntoView({ block: 'nearest' }); return;
  }
  if (command === 'show-flow') { activateTab('flow'); return; }
  activateTab('chat'); window.setTimeout(() => $<HTMLTextAreaElement>('chat-input').focus(), 0);
}

async function commentSelectionForLines(file: string, startLine: number, endLine: number, symbolId?: string): Promise<AISelection | null> {
  const source = file === state.currentFile ? editor.getModel()?.getValue() : await window.codeTutor.readSource(file);
  if (source === undefined) return null;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(1, Math.min(startLine, lines.length));
  const end = Math.max(start, Math.min(endLine, lines.length));
  const text = lines.slice(start - 1, end).join('\n');
  return { file, startLine: start, endLine: end, text, symbolId, codeHash: await sha256(text) };
}

async function resolveCommentTarget(scope = $<HTMLSelectElement>('comment-target').value): Promise<AISelection | null> {
  if (!state.currentFile) return null;
  if (scope === 'selection') {
    const selection = editor.getSelection();
    if (!selection || selection.isEmpty()) return null;
    const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
    return commentSelectionForLines(state.currentFile, selection.startLineNumber, end, state.currentSymbol?.id);
  }
  if (scope === 'symbol' && state.currentSymbol) {
    const range = state.currentSymbol.definition ?? state.currentSymbol.declaration;
    return commentSelectionForLines(range.file, range.startLine, range.endLine, state.currentSymbol.id);
  }
  const lineCount = editor.getModel()?.getLineCount() ?? 1;
  return commentSelectionForLines(state.currentFile, 1, lineCount);
}

async function updateCommentTarget(): Promise<void> {
  const target = await resolveCommentTarget();
  state.commentTarget = target;
  const chunkCount = target ? splitCommentText(target.text, COMMENT_CHUNK_CHARACTERS).length : 0;
  $('comment-target-label').textContent = target
    ? `${target.file}:${target.startLine}-${target.endLine} · ${target.text.split('\n').length.toLocaleString('ko-KR')}줄${chunkCount > 1 ? ` · 대형 범위는 ${chunkCount.toLocaleString('ko-KR')}개 구간으로 나누어 생성` : ''}`
    : '선택한 범위에 적용할 코드가 없습니다.';
  $<HTMLButtonElement>('comment-create').disabled = !target;
  $<HTMLButtonElement>('comment-apply').disabled = true;
  state.commentOutput = ''; $<HTMLTextAreaElement>('comment-preview').value = '';
}

function updateCommentMode(clearPreview = true): void {
  const mode = $<HTMLSelectElement>('comment-mode').value as NonNullable<AIRequest['commentMode']>;
  $('comment-instruction-row').hidden = mode !== 'custom';
  $<HTMLSelectElement>('comment-language').disabled = mode === 'remove';
  for (const id of ['comment-ai-engine', 'comment-ai-model', 'comment-ai-effort', 'comment-ai-fast']) {
    $<HTMLInputElement | HTMLSelectElement>(id).disabled = mode === 'remove';
  }
  $('comment-ai-options').classList.toggle('disabled', mode === 'remove');
  if (mode === 'remove') $('comment-ai-note').textContent = '주석 제거는 AI를 호출하지 않습니다.';
  else updateCommentAIStatusNote();
  $<HTMLButtonElement>('comment-create').textContent = mode === 'remove' ? '제거 미리보기' : '주석 생성';
  if (clearPreview) {
    state.commentOutput = '';
    state.activeCommentJob = null;
    state.commentBatch = null;
    $<HTMLTextAreaElement>('comment-preview').value = '';
    $<HTMLButtonElement>('comment-apply').disabled = true;
    $('comment-status').textContent = '';
  }
}

function setCommentGenerationRunning(running: boolean): void {
  for (const id of ['comment-target', 'comment-mode', 'comment-language', 'comment-instruction', 'comment-ai-engine', 'comment-ai-model', 'comment-ai-effort', 'comment-ai-fast']) {
    $<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id).disabled = running;
  }
  if (!running) updateCommentMode(false);
  $<HTMLButtonElement>('comment-create').disabled = running || !state.commentTarget;
}

async function openCommentDialog(preferred?: 'selection' | 'symbol' | 'file'): Promise<void> {
  if (!state.currentFile) return;
  const select = $<HTMLSelectElement>('comment-target');
  const hasSelection = Boolean(await currentSelection());
  const selectionOption = [...select.options].find((option) => option.value === 'selection');
  const symbolOption = [...select.options].find((option) => option.value === 'symbol');
  if (selectionOption) selectionOption.disabled = !hasSelection;
  if (symbolOption) symbolOption.disabled = !state.currentSymbol;
  select.value = preferred === 'selection' && hasSelection
    ? 'selection'
    : preferred === 'symbol' && state.currentSymbol
      ? 'symbol'
      : hasSelection ? 'selection' : state.currentSymbol ? 'symbol' : 'file';
  $('comment-status').textContent = '';
  await updateCommentTarget();
  updateCommentMode(false);
  $<HTMLDialogElement>('comment-dialog').showModal();
}

async function createComments(): Promise<void> {
  const target = await resolveCommentTarget();
  if (!target) { toast('주석을 생성할 코드 범위를 선택하세요.', true); return; }
  const mode = $<HTMLSelectElement>('comment-mode').value as NonNullable<AIRequest['commentMode']>;
  const instruction = $<HTMLTextAreaElement>('comment-instruction').value.trim();
  if (mode === 'custom' && !instruction) { toast('원하는 주석 방식이나 언어를 추가 요청에 입력하세요.', true); return; }
  state.commentTarget = target; state.commentOutput = '';
  $<HTMLTextAreaElement>('comment-preview').value = '';
  if (mode === 'remove') {
    const stripped = removeCComments(target.text);
    state.activeCommentJob = null;
    state.commentOutput = `\`\`\`c\n${stripped}\n\`\`\``;
    $<HTMLTextAreaElement>('comment-preview').value = stripped.trimEnd();
    $('comment-status').className = 'result-status';
    $('comment-status').textContent = '주석 제거 미리보기 준비됨 · AI를 호출하지 않았습니다.';
    $<HTMLButtonElement>('comment-apply').disabled = false;
    return;
  }
  const languageValue = $<HTMLSelectElement>('comment-language').value as 'ko' | 'en';
  const language = languageValue === 'en' ? '영어' : '한국어';
  await persistCommentAISettings();
  const commentAI = selectedCommentAI();
  const rawChunks = splitCommentText(target.text, COMMENT_CHUNK_CHARACTERS);
  const chunks = await Promise.all(rawChunks.map(async (chunk) => ({
    file: target.file,
    startLine: target.startLine + chunk.startLineOffset,
    endLine: target.startLine + chunk.endLineOffset,
    text: chunk.text,
    symbolId: rawChunks.length === 1 ? target.symbolId : undefined,
    codeHash: await sha256(chunk.text),
  } satisfies AISelection)));
  state.commentBatch = {
    target,
    chunks,
    outputs: Array.from({ length: chunks.length }, () => ''),
    activeIndex: 0,
    request: {
      commentMode: mode,
      commentLanguage: languageValue,
      commentInstruction: mode === 'custom' ? instruction : undefined,
      ...commentAI,
    },
  };
  setCommentGenerationRunning(true);
  $('comment-status').className = 'result-status running';
  $('comment-status').textContent = `${commentAI.engine === 'codex' ? 'Codex' : 'Claude'} · ${commentAI.model} · ${commentAI.effort}${commentAI.fast ? ' · FAST' : ''}로 ${mode === 'custom' ? '요청 맞춤' : language} 주석 생성 준비 중…`;
  await startCommentBatchChunk(0);
}

async function startCommentBatchChunk(index: number): Promise<void> {
  const batch = state.commentBatch;
  if (!batch || index < 0 || index >= batch.chunks.length) return;
  batch.activeIndex = index;
  $('comment-status').className = 'result-status running';
  $('comment-status').textContent = `주석 생성 중 · ${index + 1}/${batch.chunks.length} 구간 (${batch.chunks[index]!.startLine}-${batch.chunks[index]!.endLine}줄)`;
  const job = await guarded(() => window.codeTutor.startAI({
    kind: 'comment',
    selection: batch.chunks[index],
    ...batch.request,
  }), 'AI 주석 생성');
  if (!job) {
    state.activeCommentJob = null; state.commentBatch = null;
    setCommentGenerationRunning(false);
    return;
  }
  state.activeCommentJob = job.id; state.jobs.set(job.id, job); renderJobs();
}

async function applyComments(): Promise<void> {
  if (!state.commentTarget || !state.commentOutput) return;
  const result = await guarded<CommentApplyResult>(() => window.codeTutor.applyGeneratedComments({
    file: state.commentTarget!.file,
    startLine: state.commentTarget!.startLine,
    endLine: state.commentTarget!.endLine,
    codeHash: state.commentTarget!.codeHash,
    aiOutput: state.commentOutput,
  }), '주석 적용');
  if (!result) return;
  if (!result.applied) { $('comment-status').className = 'result-status'; $('comment-status').textContent = result.reason ?? '주석을 적용하지 못했습니다.'; return; }
  const targetFile = state.commentTarget.file;
  $<HTMLDialogElement>('comment-dialog').close();
  await openFile(targetFile);
  toast(`주석을 적용했습니다. 원본 백업: ${result.backupPath ?? '.codetutor-next/comment-backups'}`);
}

async function refreshNotes(selectId?: string): Promise<void> {
  const notes = await guarded(() => window.codeTutor.listNotes(), '학습 노트'); if (!notes) return;
  const list = $('notes-list'); list.replaceChildren();
  notes.forEach((note) => {
    const button = document.createElement('button'); button.className = `note-item${note.id === (selectId ?? state.currentNoteId) ? ' active' : ''}`;
    const title = document.createElement('strong'); title.textContent = `${note.needsReview ? '🔁 ' : ''}${note.title}`; const date = document.createElement('small'); date.textContent = new Date(note.updatedAt).toLocaleDateString('ko-KR'); button.append(title, date);
    button.addEventListener('click', () => editNote(note)); list.append(button);
  });
}

function editNote(note: StudyNote | null): void {
  state.currentNoteId = note?.id ?? null; $<HTMLInputElement>('note-title').value = note?.title ?? ''; $<HTMLTextAreaElement>('note-body').value = note?.body ?? ''; $<HTMLInputElement>('note-review').checked = note?.needsReview ?? false; void refreshNotes();
}

async function saveNote(): Promise<void> {
  const title = $<HTMLInputElement>('note-title').value; const body = $<HTMLTextAreaElement>('note-body').value;
  if (!title.trim() && !body.trim()) { toast('노트 내용을 입력하세요.', true); return; }
  const anchorRange = state.currentSymbol?.definition ?? state.currentSymbol?.declaration;
  const note = await guarded(() => window.codeTutor.saveNote({ id: state.currentNoteId ?? undefined, title, body, symbolId: state.currentSymbol?.id, anchors: anchorRange ? [anchorRange] : [], needsReview: $<HTMLInputElement>('note-review').checked }), '노트 저장');
  if (note) { state.currentNoteId = note.id; toast('학습 노트를 저장했습니다.'); await refreshNotes(note.id); }
}

async function refreshQuizzes(): Promise<void> {
  const quizzes = await guarded(() => window.codeTutor.listQuizzes(state.currentSymbol?.id), '이해도 체크'); if (!quizzes) return;
  const list = $('quiz-list'); list.replaceChildren();
  if (!quizzes.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '이 함수의 이해도 체크가 아직 없습니다.'; list.append(empty); return; }
  quizzes.forEach((quiz) => list.append(renderQuiz(quiz)));
}

function renderQuiz(quiz: QuizSession): HTMLElement {
  const card = document.createElement('section'); card.className = 'quiz-card'; const heading = document.createElement('h3'); heading.textContent = `${new Date(quiz.createdAt).toLocaleString('ko-KR')} · ${quiz.completed ? '완료' : '진행 중'}`; card.append(heading);
  quiz.questions.forEach((question, index) => {
    const area = document.createElement('div'); area.className = 'quiz-question'; const prompt = document.createElement('p'); prompt.textContent = `${index + 1}. ${question.question}`; area.append(prompt);
    const row = document.createElement('div'); row.className = 'quiz-answer'; const input = document.createElement('input'); input.placeholder = '내 말로 답하기'; input.value = question.answer ?? ''; const button = document.createElement('button'); button.className = 'ghost'; button.textContent = '확인';
    button.addEventListener('click', async () => { if (!input.value.trim()) return; await window.codeTutor.answerQuiz({ quizId: quiz.id, questionId: question.id, answer: input.value }); await refreshQuizzes(); await refreshNotes(); });
    row.append(input, button); area.append(row);
    if (question.feedback) { const feedback = document.createElement('div'); feedback.className = `quiz-feedback${question.correct ? '' : ' wrong'}`; feedback.textContent = question.feedback; area.append(feedback); }
    card.append(area);
  });
  return card;
}

async function createQuiz(): Promise<void> {
  if (!state.currentSymbol || state.currentSymbol.kind !== 'function') return;
  activateTab('notes'); const job = await guarded(() => window.codeTutor.startAI({ kind: 'quiz', symbolId: state.currentSymbol!.id, ...selectedAI() }), '이해도 체크');
  if (job) { state.jobs.set(job.id, job); renderJobs(); toast('이해도 체크를 생성하고 있습니다. 다른 탭으로 이동해도 계속됩니다.'); }
}

function renderSnapshot(snapshot: ProjectSnapshot): void {
  const projectChanged = state.snapshot?.rootPath !== snapshot.rootPath;
  const indexChanged = state.snapshot?.stats.indexedAt !== snapshot.stats.indexedAt;
  const previousSymbolId = state.currentSymbol?.id;
  if (indexChanged) { state.symbolInsights.clear(); state.projectInsight = null; }
  if (projectChanged) {
    state.expandedFolders.clear(); state.currentSymbol = null; state.currentSelection = null; state.questionContext = null;
    state.currentChatId = null; state.currentNoteId = null;
    state.graph = null; state.graphFocusId = null; state.flowLocation = null;
    $('symbol-empty').hidden = false; $('symbol-content').hidden = true;
    const rootSelect = $<HTMLSelectElement>('flow-root'); rootSelect.replaceChildren();
    const rootOption = document.createElement('option'); rootOption.value = ''; rootOption.textContent = '프로그램 전체'; rootSelect.append(rootOption);
    updateFlowLocation(null);
    state.symbolInsights.clear(); state.projectInsight = null; state.analysisStatus = null; renderAnalysisStatus();
  }
  state.snapshot = snapshot; $('project-name').textContent = snapshot.rootName; $('project-summary').textContent = `${snapshot.stats.functions}개 함수 · ${snapshot.stats.variables}개 변수 · ${snapshot.stats.files}개 파일`;
  renderAnalysisStatus();
  $('project-limitations').replaceChildren(...snapshot.limitations.map((text) => { const item = document.createElement('li'); item.textContent = text; return item; }));
  $<HTMLButtonElement>('ask-project').disabled = false; $<HTMLButtonElement>('explain-selection').disabled = false;
  $<HTMLButtonElement>('reference-button').disabled = false;
  $<HTMLButtonElement>('refresh-project').disabled = false;
  setIndexState('준비', 'ready'); renderProjectNavigator($<HTMLInputElement>('file-search').value); updateBreadcrumbs(); updateQuestionContext(); updateExplainScope();
  if (indexChanged && !projectChanged && previousSymbolId) void selectSymbol(previousSymbolId);
}

let pendingAnalysisChoice: Promise<'keep' | 'update'> | null = null;

function promptForAnalysisChange(cache: AnalysisCacheState): Promise<'keep' | 'update'> {
  if (pendingAnalysisChoice) return pendingAnalysisChoice;
  const dialog = $<HTMLDialogElement>('analysis-change-dialog');
  $('analysis-change-summary').textContent = `저장된 설명 ${cache.cachedCount.toLocaleString('ko-KR')}개 중 현재 코드와 바로 일치하는 설명은 ${cache.compatibleCount.toLocaleString('ko-KR')}개입니다.`;
  $('analysis-change-detail').textContent = `변경·삭제된 심볼 ${cache.staleCount.toLocaleString('ko-KR')}개 · 새 심볼 ${cache.newCount.toLocaleString('ko-KR')}개`;
  dialog.showModal();
  pendingAnalysisChoice = new Promise((resolve) => {
    const keep = $<HTMLButtonElement>('analysis-keep');
    const update = $<HTMLButtonElement>('analysis-update');
    const finish = (choice: 'keep' | 'update') => {
      keep.removeEventListener('click', chooseKeep); update.removeEventListener('click', chooseUpdate); dialog.removeEventListener('cancel', preventCancel);
      dialog.close(); pendingAnalysisChoice = null; resolve(choice);
    };
    const chooseKeep = () => finish('keep');
    const chooseUpdate = () => finish('update');
    const preventCancel = (event: Event) => event.preventDefault();
    keep.addEventListener('click', chooseKeep); update.addEventListener('click', chooseUpdate); dialog.addEventListener('cancel', preventCancel);
  });
  return pendingAnalysisChoice;
}

async function applyAnalysisCacheMode(cache: AnalysisCacheState, mode: 'keep' | 'update', settings: AppSettings): Promise<void> {
  const applied = await guarded(() => window.codeTutor.setAnalysisCacheMode({ mode, sourceHash: cache.currentHash }), '분석 캐시 선택');
  if (applied === null) return;
  if (mode === 'keep') {
    state.analysisStatus = {
      state: 'done', model: state.analysisStatus?.model ?? '저장된 분석', effort: state.analysisStatus?.effort ?? 'low', fast: state.analysisStatus?.fast ?? true,
      total: cache.cachedCount, completed: cache.cachedCount, cached: cache.cachedCount, failed: 0,
      profileReady: true, message: '이전 코드 기준 분석을 유지하고 있습니다. 설명에 오래된 분석 배지가 표시됩니다.',
    };
    renderAnalysisStatus();
    await refreshProjectInsight();
    if (state.currentSymbol) await loadSymbolInsight(state.currentSymbol, true);
    return;
  }
  if (settings.autoAnalyzeSymbols || cache.changed) void startBackgroundAnalysis();
}

async function resolveAnalysisPolicy(ui: Awaited<ReturnType<CodeTutorApi['getUiState']>>, settings: AppSettings): Promise<void> {
  const cache = await guarded(() => window.codeTutor.getAnalysisCacheState(), '분석 캐시 확인');
  if (!cache) return;
  let mode: 'keep' | 'update' = 'update';
  if (cache.changed) {
    if (ui.analysisDecisionHash === cache.currentHash) mode = ui.keepStaleAnalysis ? 'keep' : 'update';
    else {
      mode = await promptForAnalysisChange(cache);
      await window.codeTutor.saveUiState({ analysisDecisionHash: cache.currentHash, keepStaleAnalysis: mode === 'keep' });
    }
  }
  await applyAnalysisCacheMode(cache, mode, settings);
}

async function openProject(root?: string): Promise<void> {
  const selected = root ?? await window.codeTutor.pickProject(); if (!selected) return;
  setIndexState('인덱싱…', 'busy'); setStatus('프로젝트 C 파일을 인덱싱하고 있습니다…');
  const snapshot = await guarded(() => window.codeTutor.openProject(selected), '프로젝트 열기'); if (!snapshot) { setIndexState('오류'); return; }
  renderSnapshot(snapshot); $('welcome').hidden = true;
  const ui = await window.codeTutor.getUiState();
  applyPaneWidths(ui.leftWidth, ui.rightWidth); activateTab(ui.activeTab, false);
  const first = ui.lastFile && snapshot.files.some((file) => file.path === ui.lastFile) ? ui.lastFile : snapshot.files.find((file) => file.kind === 'c')?.path ?? snapshot.files[0]?.path;
  if (first) await openFile(first);
  await Promise.all([refreshGraph(), refreshChats(ui.lastChatId), refreshNotes(), refreshQuizzes(), refreshReference()]);
  const current = await window.codeTutor.getSettings(); state.settings = current; renderProjectWorkspace(current); setStatus(`인덱싱 완료 · 구문 오류 표시 ${snapshot.stats.parseErrors}건`);
  await resolveAnalysisPolicy(ui, current);
}

async function refreshActiveProject(): Promise<void> {
  if (!state.snapshot) { toast('새로고침할 프로젝트가 없습니다.', true); return; }
  const button = $<HTMLButtonElement>('refresh-project');
  const currentFile = state.currentFile;
  button.disabled = true; button.classList.add('spinning');
  setIndexState('새로고침…', 'busy'); setStatus('프로젝트 변경 사항을 확인하고 있습니다…');
  try {
    const snapshot = await guarded(() => window.codeTutor.refreshProject(), '프로젝트 새로고침');
    if (!snapshot) { setIndexState('오류'); return; }
    renderSnapshot(snapshot); $('welcome').hidden = true;
    if (currentFile && snapshot.files.some((file) => file.path === currentFile)) await openFile(currentFile);
    await refreshGraph($<HTMLSelectElement>('flow-root').value || undefined);
    const [cache, settings] = await Promise.all([
      guarded(() => window.codeTutor.getAnalysisCacheState(), '변경된 심볼 확인'),
      window.codeTutor.getSettings(),
    ]);
    state.settings = settings; renderProjectWorkspace(settings);
    if (!cache) return;
    if (!cache.changed) {
      await refreshProjectInsight();
      if (state.currentSymbol) await loadSymbolInsight(state.currentSymbol, true);
      setStatus('프로젝트 새로고침 완료 · 코드 변경 사항 없음');
      toast('코드 변경 사항이 없습니다. 기존 심볼 분석을 그대로 사용합니다.');
      return;
    }
    const mode = await promptForAnalysisChange(cache);
    await window.codeTutor.saveUiState({ analysisDecisionHash: cache.currentHash, keepStaleAnalysis: mode === 'keep' });
    await applyAnalysisCacheMode(cache, mode, settings);
    if (mode === 'update') {
      setStatus(`프로젝트 갱신 완료 · 변경·새 심볼 ${(cache.staleCount + cache.newCount).toLocaleString('ko-KR')}개를 증분 분석합니다.`);
      toast('변경된 심볼만 다시 분석하고, 일치하는 기존 설명은 재사용합니다.');
    } else {
      setStatus('프로젝트 갱신 완료 · 기존 분석 유지');
      toast('코드는 새로 읽었으며, 기존 분석 설명은 사용자의 선택대로 유지합니다.');
    }
  } finally {
    button.classList.remove('spinning');
    button.disabled = !state.snapshot;
    if (state.snapshot) setIndexState('준비', 'ready');
  }
}

async function closeProject(root: string): Promise<void> {
  const name = root.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? root;
  const result = await guarded(() => window.codeTutor.closeProject(root), '프로젝트 닫기');
  if (!result) return;
  state.settings = result.settings;
  renderProjectWorkspace(result.settings);
  if (!result.activeClosed) {
    toast(`${name} 프로젝트를 목록에서 닫았습니다. 저장된 분석과 대화는 유지됩니다.`);
    return;
  }
  if (result.nextProject) {
    await openProject(result.nextProject);
    toast(`${name} 프로젝트를 닫고 다음 프로젝트로 전환했습니다.`);
    return;
  }
  window.location.reload();
}

function applyPaneWidths(requestedLeft: number, requestedRight: number): void {
  const workspace = $('workspace');
  const total = workspace.clientWidth || window.innerWidth;
  const { left, right } = clampPaneWidths(total, requestedLeft, requestedRight);
  workspace.style.setProperty('--left-width', `${left}px`);
  workspace.style.setProperty('--right-width', `${right}px`);
  window.requestAnimationFrame(() => editor.layout());
}

function renderProjectWorkspace(settings: AppSettings): void {
  const host = $('project-list'); host.replaceChildren();
  const projects = state.snapshot?.rootPath && !settings.openProjects.includes(state.snapshot.rootPath)
    ? [...settings.openProjects, state.snapshot.rootPath]
    : settings.openProjects;
  if (!projects.length) {
    const empty = document.createElement('p'); empty.className = 'project-list-empty'; empty.textContent = '가져온 프로젝트가 없습니다.';
    host.append(empty); return;
  }
  for (const project of projects) {
    const active = project === (state.snapshot?.rootPath ?? settings.activeProject);
    const segments = project.replaceAll('\\', '/').split('/').filter(Boolean);
    const row = document.createElement('div'); row.className = `project-row${active ? ' active' : ''}`;
    const button = document.createElement('button');
    button.className = `project-item${active ? ' active' : ''}`;
    button.title = project;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(active));
    const indicator = document.createElement('span'); indicator.className = 'project-indicator'; indicator.textContent = active ? '●' : '○'; indicator.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span'); copy.className = 'project-item-copy';
    const name = document.createElement('strong'); name.textContent = segments.at(-1) ?? project;
    const parent = document.createElement('small'); parent.textContent = segments.slice(0, -1).join('/') || project;
    copy.append(name, parent); button.append(indicator, copy);
    if (active) { const current = document.createElement('span'); current.className = 'project-current'; current.textContent = '현재'; button.append(current); }
    button.addEventListener('click', () => { if (state.snapshot?.rootPath !== project) void openProject(project); });
    const close = document.createElement('button'); close.className = 'icon project-close'; close.type = 'button'; close.textContent = '×';
    close.title = `${segments.at(-1) ?? project} 닫기`; close.setAttribute('aria-label', close.title);
    close.addEventListener('click', (event) => { event.stopPropagation(); void closeProject(project); });
    row.append(button, close); host.append(row);
  }
}

function wireSplitters(): void {
  const workspace = $('workspace');
  const paneWidth = (name: '--left-width' | '--right-width'): number => {
    const inline = Number.parseFloat(workspace.style.getPropertyValue(name));
    return Number.isFinite(inline) ? inline : Number.parseFloat(getComputedStyle(workspace).getPropertyValue(name));
  };
  const save = () => {
    if (!state.snapshot) return;
    void window.codeTutor.saveUiState({ leftWidth: paneWidth('--left-width'), rightWidth: paneWidth('--right-width') });
  };
  const wire = (id: string, side: 'left' | 'right') => {
    const splitter = $(id); splitter.addEventListener('pointerdown', (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      splitter.classList.add('dragging'); workspace.classList.add('resizing');
      splitter.setPointerCapture(down.pointerId);
      editor.updateOptions({ automaticLayout: false });
      const box = workspace.getBoundingClientRect();
      const oppositeWidth = paneWidth(side === 'left' ? '--right-width' : '--left-width');
      let pendingWidth: number | undefined;
      let frame = 0;
      let finished = false;

      const flush = () => {
        frame = 0;
        if (pendingWidth === undefined) return;
        workspace.style.setProperty(side === 'left' ? '--left-width' : '--right-width', `${pendingWidth}px`);
        pendingWidth = undefined;
      };
      const move = (event: PointerEvent) => {
        const proposed = side === 'left' ? event.clientX - box.left : box.right - event.clientX;
        pendingWidth = clampDraggedPaneWidth(box.width, side, proposed, oppositeWidth);
        if (!frame) frame = window.requestAnimationFrame(flush);
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        if (frame) { window.cancelAnimationFrame(frame); frame = 0; }
        flush();
        splitter.classList.remove('dragging'); workspace.classList.remove('resizing');
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', finish);
        splitter.removeEventListener('pointercancel', finish);
        splitter.removeEventListener('lostpointercapture', finish);
        editor.updateOptions({ automaticLayout: true });
        editor.layout();
        save();
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', finish);
      splitter.addEventListener('pointercancel', finish);
      splitter.addEventListener('lostpointercapture', finish);
    });
  };
  wire('left-splitter', 'left'); wire('right-splitter', 'right');

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      applyPaneWidths(paneWidth('--left-width'), paneWidth('--right-width'));
    });
  });
}

function hideEditorContextMenu(): void { $('editor-context-menu').hidden = true; }

async function showEditorContextMenu(clientX: number, clientY: number): Promise<void> {
  state.currentSelection = await currentSelection();
  const hasSelection = Boolean(state.currentSelection);
  $<HTMLButtonElement>('context-ask-selection').disabled = !hasSelection;
  $<HTMLButtonElement>('context-explain-selection').disabled = !hasSelection;
  $<HTMLButtonElement>('context-comment-selection').disabled = !hasSelection;
  $<HTMLButtonElement>('context-ask-project').disabled = !state.snapshot;
  $<HTMLButtonElement>('context-flow').disabled = !state.graphFocusId;
  const menu = $('editor-context-menu'); menu.hidden = false;
  const width = 260; const height = menu.offsetHeight || 190;
  menu.style.left = `${Math.max(4, Math.min(clientX, window.innerWidth - width - 5))}px`;
  menu.style.top = `${Math.max(4, Math.min(clientY, window.innerHeight - height - 5))}px`;
}

function wireUi(): void {
  $('open-project').addEventListener('click', () => void openProject()); $('welcome-open').addEventListener('click', () => void openProject());
  $('refresh-project').addEventListener('click', () => void refreshActiveProject());
  $<HTMLInputElement>('file-search').addEventListener('input', (event) => renderProjectNavigator((event.target as HTMLInputElement).value));
  document.querySelectorAll<HTMLButtonElement>('[data-left-view]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll<HTMLButtonElement>('[data-left-view]').forEach((item) => item.classList.toggle('active', item === button)); $('file-tree').hidden = button.dataset.leftView !== 'files'; $('symbol-list').hidden = button.dataset.leftView !== 'symbols';
  }));
  document.querySelectorAll<HTMLButtonElement>('#right-tabs button').forEach((button) => button.addEventListener('click', () => activateTab(button.dataset.tab!)));
  $('jobs-button').addEventListener('click', () => { const popover = $('jobs-popover'); popover.hidden = !popover.hidden; $('jobs-button').setAttribute('aria-expanded', String(!popover.hidden)); }); $('jobs-close').addEventListener('click', () => { $('jobs-popover').hidden = true; });
  $('reference-button').addEventListener('click', () => { const popover = $('reference-popover'); popover.hidden = !popover.hidden; if (!popover.hidden) void refreshReference(); });
  $('reference-close').addEventListener('click', () => { $('reference-popover').hidden = true; });
  $('reference-pick').addEventListener('click', () => void pickReferenceFolder());
  $('reference-clear').addEventListener('click', async () => { const info = await guarded(() => window.codeTutor.clearReferenceFolder(), '레퍼런스 연결 해제'); if (info) renderReference(info); });
  $('flow-reset').addEventListener('click', () => { $<HTMLSelectElement>('flow-root').value = ''; void refreshGraph(); });
  $('flow-locate').addEventListener('click', () => void locateCurrentFlow());
  $<HTMLSelectElement>('flow-root').addEventListener('change', (event) => void refreshGraph((event.target as HTMLSelectElement).value || undefined));
  ['ai-engine', 'ai-effort', 'ai-fast'].forEach((id) => $(id).addEventListener('change', () => { if (id === 'ai-engine') updateModelOptions(); void persistAISettings(); }));
  $('ai-model').addEventListener('change', () => { updateEffortOptions(); void persistAISettings(); });
  $('auto-symbol-analysis').addEventListener('change', async () => {
    await persistAISettings();
    if ($<HTMLInputElement>('auto-symbol-analysis').checked) void startBackgroundAnalysis();
    else {
      const status = await guarded(() => window.codeTutor.cancelBackgroundAnalysis(), '사전 분석 중지');
      if (status) { state.analysisStatus = status; renderAnalysisStatus(); }
    }
  });
  $('explain-scope').addEventListener('change', () => updateExplainScope());
  $('generate-explanation').addEventListener('click', () => void startExplanation()); $('explain-selection').addEventListener('click', () => void startExplanation('project'));
  $('ask-project').addEventListener('click', () => askWholeProject());
  $('ask-selection').addEventListener('click', () => void askWithCurrentSelection());
  $('generate-comments').addEventListener('click', () => void openCommentDialog());
  $('send-chat').addEventListener('click', () => void sendChat()); $<HTMLTextAreaElement>('chat-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendChat(); } });
  $('new-chat').addEventListener('click', () => { state.questionContext = null; updateQuestionContext(); $<HTMLSelectElement>('chat-history').value = ''; void renderChat(null); });
  $<HTMLSelectElement>('chat-history').addEventListener('change', async (event) => { const id = (event.target as HTMLSelectElement).value; await renderChat(id ? await window.codeTutor.getChat(id) : null); });
  $('chat-context').addEventListener('click', () => { if (state.questionContext) void navigate({ file: state.questionContext.file, startLine: state.questionContext.startLine, startColumn: 1, endLine: state.questionContext.endLine, endColumn: 1 }); });
  $('clear-chat-context').addEventListener('click', () => { state.questionContext = null; updateQuestionContext(); });
  $('new-note').addEventListener('click', () => editNote(null)); $('save-note').addEventListener('click', () => void saveNote());
  $('export-notes').addEventListener('click', () => void exportLearningNotes()); $('create-quiz').addEventListener('click', () => void createQuiz());
  $<HTMLSelectElement>('comment-target').addEventListener('change', () => void updateCommentTarget());
  $<HTMLSelectElement>('comment-mode').addEventListener('change', () => updateCommentMode());
  $<HTMLSelectElement>('comment-ai-engine').addEventListener('change', () => {
    const engine = $<HTMLSelectElement>('comment-ai-engine').value;
    updateCommentModelOptions(engine === 'codex' ? 'gpt-5.6-sol' : 'default');
    void persistCommentAISettings();
  });
  $<HTMLSelectElement>('comment-ai-model').addEventListener('change', () => { updateCommentEffortOptions(); updateCommentAIStatusNote(); void persistCommentAISettings(); });
  $<HTMLSelectElement>('comment-ai-effort').addEventListener('change', () => void persistCommentAISettings());
  $<HTMLInputElement>('comment-ai-fast').addEventListener('change', () => void persistCommentAISettings());
  $('comment-create').addEventListener('click', () => void createComments());
  $('comment-apply').addEventListener('click', () => void applyComments());
  $('context-ask-selection').addEventListener('click', () => { hideEditorContextMenu(); void askWithCurrentSelection(); });
  $('context-explain-selection').addEventListener('click', () => { hideEditorContextMenu(); void startExplanation('selection'); });
  $('context-comment-selection').addEventListener('click', () => { hideEditorContextMenu(); void openCommentDialog('selection'); });
  $('context-ask-project').addEventListener('click', () => { hideEditorContextMenu(); askWholeProject(); });
  $('context-flow').addEventListener('click', () => { hideEditorContextMenu(); activateTab('flow'); void locateCurrentFlow(); });
  wireSplitters();
}

async function handleIndexUpdated(snapshot: ProjectSnapshot): Promise<void> {
  const currentFile = state.currentFile;
  renderSnapshot(snapshot);
  toast('변경된 C 파일을 다시 인덱싱했습니다.');
  if (currentFile && snapshot.files.some((file) => file.path === currentFile)) await openFile(currentFile);
  await refreshGraph($<HTMLSelectElement>('flow-root').value || undefined);
  const [ui, settings] = await Promise.all([window.codeTutor.getUiState(), window.codeTutor.getSettings()]);
  state.settings = settings; renderProjectWorkspace(settings);
  await resolveAnalysisPolicy(ui, settings);
}

function wireEditor(): void {
  editor.onMouseDown((event) => {
    if (!event.event.leftButton || !event.target.position) return;
    clearCodeHighlight();
    const { lineNumber, column } = event.target.position;
    if (event.event.ctrlKey || event.event.metaKey) {
      event.event.preventDefault();
      event.event.stopPropagation();
      void goToDefinitionAt(lineNumber, column);
    } else void inspectAt(lineNumber, column);
  });
  editor.onDidChangeCursorPosition((event) => { $('cursor-position').textContent = `Ln ${event.position.lineNumber}, Col ${event.position.column}`; });
  editor.onDidChangeCursorSelection(async () => {
    state.currentSelection = await currentSelection();
    const has = Boolean(state.currentSelection); $<HTMLButtonElement>('ask-selection').disabled = !has;
    $('selection-summary').textContent = has ? `${state.currentSelection!.startLine}-${state.currentSelection!.endLine}줄 선택` : '';
    updateExplainScope();
  });
  editor.addAction({ id: 'codetutor.ask-selection', label: 'Auto CodeTutor: 선택 영역으로 질문', precondition: 'editorHasSelection', contextMenuGroupId: 'navigation', contextMenuOrder: 1, run: () => void askWithCurrentSelection() });
  editor.addAction({ id: 'codetutor.ask-project', label: 'Auto CodeTutor: 프로젝트 전체에 질문', contextMenuGroupId: 'navigation', contextMenuOrder: 2, run: () => askWholeProject() });
  editor.addAction({ id: 'codetutor.explain-selection', label: 'Auto CodeTutor: 선택 영역 해설', precondition: 'editorHasSelection', contextMenuGroupId: 'navigation', contextMenuOrder: 3, run: async () => { state.currentSelection = await currentSelection(); updateExplainScope(); if (state.currentSelection) await startExplanation('selection'); } });
  editor.addAction({ id: 'codetutor.flow', label: 'Auto CodeTutor: 이 함수부터 실행 개요 보기', contextMenuGroupId: 'navigation', contextMenuOrder: 4, run: () => { if (state.currentSymbol?.kind === 'function') { ensureFlowRootOption(state.currentSymbol); activateTab('flow'); $<HTMLSelectElement>('flow-root').value = state.currentSymbol.id; void refreshGraph(state.currentSymbol.id); } } });
  editor.addAction({
    id: 'codetutor.go-to-definition',
    label: 'Auto CodeTutor: 정의로 이동',
    keybindings: [monaco.KeyCode.F12],
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 0,
    run: () => { const position = editor.getPosition(); if (position) void goToDefinitionAt(position.lineNumber, position.column); },
  });
  editor.getDomNode()?.addEventListener('contextmenu', (event) => {
    event.preventDefault(); event.stopPropagation();
    void showEditorContextMenu(event.clientX, event.clientY);
  }, true);
  document.addEventListener('pointerdown', (event) => { if (!(event.target as HTMLElement).closest('#editor-context-menu')) hideEditorContextMenu(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideEditorContextMenu(); });
}

async function bootstrap(): Promise<void> {
  wireUi(); wireEditor(); updateQuestionContext(); updateExplainScope();
  window.codeTutor.onJobEvent((event) => void handleJobEvent(event));
  window.codeTutor.onBackgroundAnalysis((status) => void handleBackgroundAnalysis(status));
  window.codeTutor.onIndexUpdated((snapshot) => void handleIndexUpdated(snapshot));
  window.codeTutor.onAppCommand((command) => handleAppCommand(command));
  const [settings, engines, jobs, snapshot, analysisStatus] = await Promise.all([window.codeTutor.getSettings(), window.codeTutor.getEngines(), window.codeTutor.listJobs(), window.codeTutor.getSnapshot(), window.codeTutor.getBackgroundAnalysisStatus()]);
  state.settings = settings; state.engines = engines; jobs.forEach((job) => state.jobs.set(job.id, job)); renderJobs(); renderProjectWorkspace(settings);
  state.analysisStatus = analysisStatus; renderAnalysisStatus();
  $<HTMLSelectElement>('ai-engine').value = settings.engine;
  updateModelOptions(settings.model || 'default');
  if ([...$<HTMLSelectElement>('ai-effort').options].some((option) => option.value === settings.effort)) $<HTMLSelectElement>('ai-effort').value = settings.effort;
  $<HTMLInputElement>('ai-fast').checked = settings.fast;
  $<HTMLInputElement>('auto-symbol-analysis').checked = settings.autoAnalyzeSymbols;
  $<HTMLSelectElement>('comment-ai-engine').value = settings.commentEngine || 'codex';
  $<HTMLInputElement>('comment-ai-fast').checked = settings.commentFast ?? false;
  updateCommentModelOptions(settings.commentModel || 'gpt-5.6-sol', settings.commentEffort || 'medium');
  updateCommentAIStatusNote();
  if (!snapshot && settings.activeProject) {
    setStatus('마지막 작업공간을 복원하고 있습니다.');
    await openProject(settings.activeProject);
    return;
  }
  if (snapshot) {
    renderSnapshot(snapshot);
    renderProjectWorkspace(settings);
    $('welcome').hidden = true;
    const ui = await window.codeTutor.getUiState();
    applyPaneWidths(ui.leftWidth, ui.rightWidth);
    activateTab(ui.activeTab, false);
    const first = ui.lastFile && snapshot.files.some((file) => file.path === ui.lastFile)
      ? ui.lastFile
      : snapshot.files.find((file) => file.kind === 'c')?.path ?? snapshot.files[0]?.path;
    if (first) await openFile(first);
    await Promise.all([refreshGraph(), refreshChats(ui.lastChatId), refreshNotes(), refreshQuizzes(), refreshReference()]);
    await refreshProjectInsight();
    await resolveAnalysisPolicy(ui, settings);
  }
}

void bootstrap().catch((error) => setStatus(`앱 초기화 실패: ${(error as Error).message}`, true));
