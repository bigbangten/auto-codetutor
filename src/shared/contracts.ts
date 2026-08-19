export type SymbolKind =
  | 'function'
  | 'variable'
  | 'parameter'
  | 'typedef'
  | 'struct'
  | 'union'
  | 'enum'
  | 'field'
  | 'macro';

export type OriginKind = 'mex' | 'rtd' | 'ai-confirmed' | 'unknown';

export interface SourceRange {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface OriginEvidence {
  kind: OriginKind;
  label: string;
  confidence: 'confirmed' | 'strong' | 'limited';
  rule: string;
  anchors: SourceRange[];
}

export interface FieldInfo {
  name: string;
  type: string;
  range: SourceRange;
  children: FieldInfo[];
  /** Indexed symbol for this declared member, when its declaration is available. */
  symbolId?: string;
  /** Explicit enum initializer, for example 1U << 3. */
  valueExpression?: string;
  /** Macro/earlier-enumerator expanded expression when it differs from the source. */
  expandedValue?: string;
  /** Safely calculated integer value in a learning-friendly radix. */
  calculatedValue?: string;
  /** The declaration was unavailable, so this member was recovered from a . / -> use site. */
  inferred?: boolean;
}

export interface FunctionParameterInfo {
  name: string;
  type: string;
  range: SourceRange;
}

export interface SymbolInsight {
  symbolId: string;
  sourceHash: string;
  meaning: string;
  typeDescription: string;
  parameterDescriptions: Record<string, string>;
  returnDescription: string;
  impact: string;
  caveat: string;
  markdown: string;
  fieldDescriptions: Record<string, string>;
  model: string;
  updatedAt: string;
  /** The explanation was deliberately kept from an older source snapshot. */
  stale?: boolean;
}

export interface ProjectInsightStage {
  title: string;
  summary: string;
  focus: 'user' | 'platform' | 'mixed';
}

export interface ProjectInsight {
  sourceHash: string;
  purpose: string;
  stages: ProjectInsightStage[];
  model: string;
  updatedAt: string;
  /** The overview was deliberately kept from an older source snapshot. */
  stale?: boolean;
}

export interface BackgroundAnalysisStatus {
  state: 'idle' | 'queued' | 'running' | 'done' | 'error' | 'disabled';
  model: string;
  effort: AIRequest['effort'];
  fast: boolean;
  total: number;
  completed: number;
  cached: number;
  failed: number;
  profileReady: boolean;
  currentFile?: string;
  message: string;
}

export interface ReferenceInfo {
  kind: 'declaration' | 'definition' | 'read' | 'write' | 'call';
  range: SourceRange;
  container?: string;
  /** Exact assignment/update target, for example entry.flDomain or ports[index].state. */
  target?: string;
  expression?: string;
  changeDescription?: string;
  /** Right-hand expression before preprocessing, for example ACTIVE_PORT. */
  valueExpression?: string;
  /** Object-like macros recursively expanded at the use site, for example 500U. */
  expandedValue?: string;
  /** Safely calculated integer result after macro expansion. */
  calculatedValue?: string;
  valueSource?: 'constant' | 'variable' | 'call' | 'expression' | 'increment' | 'decrement' | 'initializer';
}

export interface MacroInfo {
  functionLike: boolean;
  parameters: string[];
  /** Replacement text written after the macro name/parameter list. */
  replacement: string;
  /** Object-like project macros recursively expanded without evaluating the C expression. */
  expandedReplacement?: string;
  /** Safely calculated integer result when the replacement is a portable constant expression subset. */
  calculatedValue?: string;
}

export interface CallInfo {
  name: string;
  range: SourceRange;
  symbolId?: string;
  resolved: boolean;
  arguments?: string[];
}

export interface SymbolRecord {
  id: string;
  name: string;
  kind: SymbolKind;
  type: string;
  signature?: string;
  scope: string;
  parentId?: string;
  declaration: SourceRange;
  definition?: SourceRange;
  parameters: FunctionParameterInfo[];
  returnExpressions: string[];
  fields: FieldInfo[];
  macro?: MacroInfo;
  resolvedType?: {
    symbolId: string;
    name: string;
    kind: Extract<SymbolKind, 'typedef' | 'struct' | 'union' | 'enum'>;
    range: SourceRange;
    fields: FieldInfo[];
    /** The type itself is outside the opened project and the range is a use-site fallback. */
    inferred?: boolean;
  };
  /** Aggregate context shown when inspecting a member rather than the whole object. */
  containingType?: {
    symbolId: string;
    name: string;
    range: SourceRange;
    fields: FieldInfo[];
    /** Member path from the aggregate root to the selected field. */
    path: string[];
    /** Use-site object or parameter that supplied this context. */
    owner?: string;
  };
  origin: OriginEvidence;
  references: ReferenceInfo[];
  calls: CallInfo[];
  callers: CallInfo[];
  sourceHash: string;
  limitations: string[];
  synthetic?: 'external-type' | 'external-symbol';
}

export interface SymbolSummary {
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  origin: OriginKind;
}

export interface ProjectFile {
  path: string;
  kind: 'c' | 'header' | 'mex';
  size: number;
}

export interface ProjectSnapshot {
  rootName: string;
  rootPath: string;
  files: ProjectFile[];
  symbols: SymbolSummary[];
  stats: {
    files: number;
    functions: number;
    variables: number;
    types: number;
    parseErrors: number;
    indexedAt: string;
  };
  limitations: string[];
}

export interface GraphNode {
  id: string;
  name: string;
  file: string;
  line: number;
  kind: 'entry' | 'irq' | 'function' | 'external';
  origin: OriginKind;
}

export interface GraphEdge {
  from: string;
  to: string;
  range: SourceRange;
  resolved: boolean;
}

export interface CallGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  roots: string[];
  truncated: boolean;
  limitations: string[];
}

export interface AnchorValidation {
  raw: string;
  valid: boolean;
  range?: SourceRange;
  document?: { name: string; page: number };
  reason?: string;
}

export type AIEngine = 'codex' | 'claude';
export type AIJobKind = 'explain' | 'chat' | 'quiz' | 'summary' | 'comment' | 'catalog';
export type AIJobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface AISelection {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  symbolId?: string;
  codeHash: string;
}

export interface AIRequest {
  kind: AIJobKind;
  engine: AIEngine;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  fast: boolean;
  question?: string;
  selection?: AISelection;
  symbolId?: string;
  chatId?: string;
  commentMode?: 'preserve' | 'replace' | 'custom' | 'remove';
  commentLanguage?: 'ko' | 'en';
  commentInstruction?: string;
  catalogMode?: 'project-profile' | 'symbol-batch';
  symbolIds?: string[];
  analysisFile?: string;
}

export interface AIJob {
  id: string;
  kind: AIJobKind;
  engine: AIEngine;
  model: string;
  state: AIJobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  symbolId?: string;
  chatId?: string;
  analysisFile?: string;
  batchSize?: number;
  output: string;
  error?: string;
}

export interface AIJobEvent {
  type: 'created' | 'updated' | 'chunk' | 'removed';
  job: AIJob;
  chunk?: string;
}

export interface EngineInfo {
  engine: AIEngine;
  installed: boolean;
  version: string;
  models: Array<{
    id: string;
    label: string;
    description?: string;
    efforts: string[];
  }>;
  efforts: string[];
  supportsFast: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface ChatThread {
  id: string;
  title: string;
  symbolId?: string;
  anchor?: AISelection;
  sourceHash?: string;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface StudyNote {
  id: string;
  symbolId?: string;
  title: string;
  body: string;
  anchors: SourceRange[];
  needsReview: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuizQuestion {
  id: string;
  question: string;
  expected: string;
  anchor?: SourceRange;
  answer?: string;
  feedback?: string;
  correct?: boolean;
}

export interface QuizSession {
  id: string;
  symbolId: string;
  createdAt: string;
  questions: QuizQuestion[];
  completed: boolean;
}

export interface UiState {
  leftWidth: number;
  rightWidth: number;
  activeTab: string;
  lastFile?: string;
  lastChatId?: string;
  analysisDecisionHash?: string;
  keepStaleAnalysis?: boolean;
}

export interface AppSettings {
  recentProjects: string[];
  openProjects: string[];
  activeProject?: string;
  engine: AIEngine;
  model: string;
  effort: AIRequest['effort'];
  fast: boolean;
  autoAnalyzeSymbols: boolean;
  commentEngine: AIEngine;
  commentModel: string;
  commentEffort: AIRequest['effort'];
  commentFast: boolean;
}

export interface AnalysisCacheState {
  currentHash: string;
  savedHash?: string;
  hasCache: boolean;
  changed: boolean;
  cachedCount: number;
  compatibleCount: number;
  staleCount: number;
  newCount: number;
}

export interface AnalysisCacheDecision {
  mode: 'keep' | 'update';
  sourceHash: string;
}

export interface ProjectCloseResult {
  settings: AppSettings;
  activeClosed: boolean;
  nextProject?: string;
}

export interface ReferenceDocument {
  name: string;
  relativePath: string;
  kind: 'pdf' | 'text';
  pages: number;
}

export interface ReferenceFolderInfo {
  folderPath: string | null;
  documents: ReferenceDocument[];
  indexedPages: number;
  indexedAt?: string;
}

export interface CommentApplyRequest {
  file: string;
  startLine: number;
  endLine: number;
  codeHash: string;
  aiOutput: string;
}

export interface CommentApplyResult {
  applied: boolean;
  backupPath?: string;
  reason?: string;
}

export type AppCommand =
  | 'import-project'
  | 'refresh-active-project'
  | 'close-active-project'
  | 'pick-reference-folder'
  | 'export-notes'
  | 'focus-projects'
  | 'show-flow'
  | 'show-chat';

export interface CodeTutorApi {
  pickProject(): Promise<string | null>;
  openProject(rootPath: string): Promise<ProjectSnapshot>;
  refreshProject(): Promise<ProjectSnapshot>;
  closeProject(rootPath: string): Promise<ProjectCloseResult>;
  getSnapshot(): Promise<ProjectSnapshot | null>;
  readSource(relativePath: string): Promise<string>;
  getSymbolAt(input: { file: string; line: number; column: number; word: string }): Promise<SymbolRecord | null>;
  getSymbol(symbolId: string): Promise<SymbolRecord | null>;
  getGraph(input?: { rootId?: string; query?: string; limit?: number }): Promise<CallGraph>;
  validateAnchors(markdown: string): Promise<AnchorValidation[]>;
  pickReferenceFolder(): Promise<ReferenceFolderInfo | null>;
  getReferenceFolder(): Promise<ReferenceFolderInfo>;
  clearReferenceFolder(): Promise<ReferenceFolderInfo>;
  openReference(input: { name: string; page: number }): Promise<boolean>;
  getEngines(): Promise<EngineInfo[]>;
  startAI(request: AIRequest): Promise<AIJob>;
  startBackgroundAnalysis(): Promise<BackgroundAnalysisStatus>;
  restartBackgroundAnalysis(): Promise<BackgroundAnalysisStatus>;
  cancelBackgroundAnalysis(): Promise<BackgroundAnalysisStatus>;
  getBackgroundAnalysisStatus(): Promise<BackgroundAnalysisStatus>;
  getAnalysisCacheState(): Promise<AnalysisCacheState>;
  setAnalysisCacheMode(decision: AnalysisCacheDecision): Promise<void>;
  analyzeSymbol(symbolId: string): Promise<AIJob>;
  getSymbolInsight(symbolId: string): Promise<SymbolInsight | null>;
  getProjectInsight(): Promise<ProjectInsight | null>;
  cancelAI(jobId: string): Promise<boolean>;
  listJobs(): Promise<AIJob[]>;
  listChats(): Promise<ChatThread[]>;
  getChat(chatId: string): Promise<ChatThread | null>;
  deleteChat(chatId: string): Promise<boolean>;
  listNotes(): Promise<StudyNote[]>;
  saveNote(note: Partial<StudyNote> & Pick<StudyNote, 'title' | 'body'>): Promise<StudyNote>;
  deleteNote(noteId: string): Promise<boolean>;
  exportNotes(): Promise<{ canceled: boolean; path?: string }>;
  listQuizzes(symbolId?: string): Promise<QuizSession[]>;
  answerQuiz(input: { quizId: string; questionId: string; answer: string }): Promise<QuizSession | null>;
  getUiState(): Promise<UiState>;
  saveUiState(state: Partial<UiState>): Promise<UiState>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  applyGeneratedComments(request: CommentApplyRequest): Promise<CommentApplyResult>;
  onJobEvent(listener: (event: AIJobEvent) => void): () => void;
  onBackgroundAnalysis(listener: (status: BackgroundAnalysisStatus) => void): () => void;
  onIndexUpdated(listener: (snapshot: ProjectSnapshot) => void): () => void;
  onAppCommand(listener: (command: AppCommand) => void): () => void;
}
