import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AnalysisCacheState,
  AppSettings,
  ChatThread,
  QuizQuestion,
  QuizSession,
  StudyNote,
  SymbolRecord,
  SymbolInsight,
  ProjectInsight,
  UiState,
  AISelection,
} from '../shared/contracts.js';
import { readJson, safeId, writeJsonAtomic } from './json-store.js';

const DEFAULT_UI: UiState = { leftWidth: 280, rightWidth: 460, activeTab: 'symbol' };
export const DEFAULT_SETTINGS: AppSettings = {
  recentProjects: [],
  openProjects: [],
  engine: 'codex',
  model: 'default',
  effort: 'medium',
  fast: false,
  autoAnalyzeSymbols: true,
  commentEngine: 'codex',
  commentModel: 'gpt-5.6-sol',
  commentEffort: 'medium',
  commentFast: false,
};

interface SemanticCatalog {
  schema: 2;
  sourceHash?: string;
  project?: ProjectInsight;
  symbols: Record<string, SymbolInsight>;
  symbolMetadata?: Record<string, { name: string; kind: SymbolRecord['kind']; file: string; scope: string }>;
}

const EMPTY_SEMANTIC_CATALOG: SemanticCatalog = { schema: 2, symbols: {} };

export class GlobalSettingsStore {
  private readonly file: string;
  constructor(appDataPath: string) { this.file = path.join(appDataPath, 'codetutor-next', 'settings.json'); }

  async get(): Promise<AppSettings> {
    const stored = await readJson<Partial<AppSettings>>(this.file, {});
    const recentProjects = Array.isArray(stored.recentProjects) ? stored.recentProjects.filter((item): item is string => typeof item === 'string') : [];
    const openProjects = Array.isArray(stored.openProjects)
      ? stored.openProjects.filter((item): item is string => typeof item === 'string')
      : recentProjects.slice(0, 1);
    const activeProject = typeof stored.activeProject === 'string'
      ? stored.activeProject
      : openProjects[0];
    return { ...DEFAULT_SETTINGS, ...stored, recentProjects, openProjects, activeProject };
  }

  async save(changes: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.get();
    const next = { ...current, ...changes };
    next.recentProjects = [...new Set(next.recentProjects)].slice(0, 10);
    next.openProjects = [...new Set(next.openProjects)].slice(0, 12);
    if (next.activeProject && !next.openProjects.includes(next.activeProject)) next.openProjects.unshift(next.activeProject);
    await writeJsonAtomic(this.file, next);
    return next;
  }
}

export class LearningStore {
  private dataDir: string | null = null;
  private symbolResolver: ((id: string) => SymbolRecord | null) | null = null;
  private semanticCatalog: SemanticCatalog | null = null;
  private semanticLoad: Promise<SemanticCatalog> | null = null;
  private semanticWrite: Promise<void> = Promise.resolve();
  private allowStaleSemantic = false;

  bind(dataDir: string, symbolResolver: (id: string) => SymbolRecord | null): void {
    this.dataDir = dataDir;
    this.symbolResolver = symbolResolver;
    this.semanticCatalog = null;
    this.semanticLoad = null;
    this.semanticWrite = Promise.resolve();
    this.allowStaleSemantic = false;
  }

  unbind(): void {
    this.dataDir = null;
    this.symbolResolver = null;
    this.semanticCatalog = null;
    this.semanticLoad = null;
    this.semanticWrite = Promise.resolve();
    this.allowStaleSemantic = false;
  }

  private requireDir(): string {
    if (!this.dataDir) throw new Error('프로젝트를 먼저 여세요.');
    return this.dataDir;
  }

  private chatDir(): string { return path.join(this.requireDir(), 'chats'); }
  private semanticFile(): string { return path.join(this.requireDir(), 'semantic-catalog-v2.json'); }

  private async loadSemanticCatalog(): Promise<SemanticCatalog> {
    if (this.semanticCatalog) return this.semanticCatalog;
    if (!this.semanticLoad) {
      this.semanticLoad = readJson<SemanticCatalog>(this.semanticFile(), EMPTY_SEMANTIC_CATALOG).then((value) => {
        const catalog = value?.schema === 2 && value.symbols
          ? { ...value, symbols: { ...value.symbols } }
          : { ...EMPTY_SEMANTIC_CATALOG, symbols: {} };
        this.semanticCatalog = catalog;
        return catalog;
      });
    }
    return this.semanticLoad;
  }

  private async saveSemanticCatalog(): Promise<void> {
    const catalog = await this.loadSemanticCatalog();
    this.semanticWrite = this.semanticWrite.then(() => writeJsonAtomic(this.semanticFile(), catalog));
    await this.semanticWrite;
  }
  private chatFile(id: string): string {
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('잘못된 채팅 ID입니다.');
    return path.join(this.chatDir(), `${id}.json`);
  }

  async listChats(): Promise<ChatThread[]> {
    let names: string[] = [];
    try { names = await readdir(this.chatDir()); } catch { return []; }
    const chats = (await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readJson<ChatThread | null>(path.join(this.chatDir(), name), null))))
      .filter((chat): chat is ChatThread => Boolean(chat));
    for (const chat of chats) {
      const current = chat.symbolId ? this.symbolResolver?.(chat.symbolId) : null;
      chat.stale = Boolean(chat.sourceHash && (!current || current.sourceHash !== chat.sourceHash));
    }
    return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getChat(id: string): Promise<ChatThread | null> {
    const chat = await readJson<ChatThread | null>(this.chatFile(id), null);
    if (!chat) return null;
    const current = chat.symbolId ? this.symbolResolver?.(chat.symbolId) : null;
    chat.stale = Boolean(chat.sourceHash && (!current || current.sourceHash !== chat.sourceHash));
    return chat;
  }

  async appendChat(
    chatId: string | undefined,
    role: 'user' | 'assistant',
    content: string,
    context?: { title?: string; symbolId?: string; selection?: AISelection },
  ): Promise<ChatThread> {
    const now = new Date().toISOString();
    let chat = chatId ? await this.getChat(chatId) : null;
    if (!chat) {
      const symbol = context?.symbolId ? this.symbolResolver?.(context.symbolId) : null;
      chat = {
        id: safeId('chat-'),
        title: context?.title?.slice(0, 80) || content.replace(/\s+/g, ' ').slice(0, 60) || '새 질문',
        symbolId: context?.symbolId,
        anchor: context?.selection,
        sourceHash: symbol?.sourceHash ?? context?.selection?.codeHash,
        stale: false,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
    }
    chat.messages.push({ role, content, at: now });
    chat.updatedAt = now;
    await writeJsonAtomic(this.chatFile(chat.id), chat);
    return chat;
  }

  async deleteChat(id: string): Promise<boolean> {
    try { await rm(this.chatFile(id)); return true; } catch { return false; }
  }

  async listNotes(): Promise<StudyNote[]> {
    const notes = await readJson<StudyNote[]>(path.join(this.requireDir(), 'notes.json'), []);
    return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveNote(input: Partial<StudyNote> & Pick<StudyNote, 'title' | 'body'>): Promise<StudyNote> {
    const notes = await this.listNotes();
    const now = new Date().toISOString();
    const existing = input.id ? notes.find((note) => note.id === input.id) : undefined;
    const note: StudyNote = {
      id: existing?.id ?? safeId('note-'),
      symbolId: input.symbolId ?? existing?.symbolId,
      title: input.title.trim() || '제목 없는 노트',
      body: input.body,
      anchors: input.anchors ?? existing?.anchors ?? [],
      needsReview: input.needsReview ?? existing?.needsReview ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = notes.filter((item) => item.id !== note.id);
    next.push(note);
    await writeJsonAtomic(path.join(this.requireDir(), 'notes.json'), next);
    return note;
  }

  async deleteNote(id: string): Promise<boolean> {
    const notes = await this.listNotes();
    const next = notes.filter((note) => note.id !== id);
    if (next.length === notes.length) return false;
    await writeJsonAtomic(path.join(this.requireDir(), 'notes.json'), next);
    return true;
  }

  async notesMarkdown(): Promise<string> {
    const notes = await this.listNotes();
    const quizzes = await this.listQuizzes();
    const parts = ['# Auto CodeTutor 학습 노트', '', `내보낸 시각: ${new Date().toLocaleString('ko-KR')}`, ''];
    for (const note of notes) {
      parts.push(`## ${note.needsReview ? '🔁 ' : ''}${note.title}`, '', note.body, '');
      if (note.anchors.length) parts.push(`근거: ${note.anchors.map((anchor) => `[[${anchor.file}:${anchor.startLine}${anchor.endLine !== anchor.startLine ? `-${anchor.endLine}` : ''}]]`).join(', ')}`, '');
    }
    const review = quizzes.flatMap((quiz) => quiz.questions.filter((question) => question.correct === false).map((question) => ({ quiz, question })));
    if (review.length) {
      parts.push('## 복습할 항목', '');
      for (const item of review) parts.push(`- ${item.question.question} — ${item.question.feedback ?? '다시 설명해 보세요.'}`);
      parts.push('');
    }
    return `${parts.join('\n')}\n`;
  }

  async listQuizzes(symbolId?: string): Promise<QuizSession[]> {
    const quizzes = await readJson<QuizSession[]>(path.join(this.requireDir(), 'quizzes.json'), []);
    return quizzes.filter((quiz) => !symbolId || quiz.symbolId === symbolId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async addQuiz(symbolId: string, questions: Array<Pick<QuizQuestion, 'question' | 'expected' | 'anchor'>>): Promise<QuizSession> {
    const quizzes = await this.listQuizzes();
    const quiz: QuizSession = {
      id: safeId('quiz-'),
      symbolId,
      createdAt: new Date().toISOString(),
      completed: false,
      questions: questions.slice(0, 3).map((question) => ({ ...question, id: safeId('question-') })),
    };
    quizzes.push(quiz);
    await writeJsonAtomic(path.join(this.requireDir(), 'quizzes.json'), quizzes);
    return quiz;
  }

  async answerQuiz(input: { quizId: string; questionId: string; answer: string }): Promise<QuizSession | null> {
    const quizzes = await this.listQuizzes();
    const quiz = quizzes.find((item) => item.id === input.quizId);
    const question = quiz?.questions.find((item) => item.id === input.questionId);
    if (!quiz || !question) return null;
    const expectedTokens = new Set(question.expected.toLocaleLowerCase('ko-KR').match(/[\p{L}\p{N}_]{2,}/gu) ?? []);
    const answerTokens = new Set(input.answer.toLocaleLowerCase('ko-KR').match(/[\p{L}\p{N}_]{2,}/gu) ?? []);
    const overlap = [...expectedTokens].filter((token) => answerTokens.has(token)).length;
    const ratio = expectedTokens.size ? overlap / expectedTokens.size : 0;
    question.answer = input.answer;
    question.correct = ratio >= 0.35 || input.answer.trim().length >= 40;
    question.feedback = question.correct
      ? `핵심을 잘 짚었습니다. 모범 설명: ${question.expected}`
      : `핵심 표현이 충분히 드러나지 않았습니다. 다시 확인할 내용: ${question.expected}`;
    quiz.completed = quiz.questions.every((item) => item.answer !== undefined);
    await writeJsonAtomic(path.join(this.requireDir(), 'quizzes.json'), quizzes);
    if (!question.correct) {
      await this.saveNote({
        title: `복습: ${question.question}`,
        body: question.feedback,
        symbolId: quiz.symbolId,
        anchors: question.anchor ? [question.anchor] : [],
        needsReview: true,
      });
    }
    return quiz;
  }

  async getUiState(): Promise<UiState> {
    return { ...DEFAULT_UI, ...(await readJson<Partial<UiState>>(path.join(this.requireDir(), 'ui-state.json'), {})) };
  }

  async saveUiState(changes: Partial<UiState>): Promise<UiState> {
    const next = { ...(await this.getUiState()), ...changes };
    next.leftWidth = Math.max(190, Math.min(next.leftWidth, 520));
    next.rightWidth = Math.max(320, Math.min(next.rightWidth, 760));
    await writeJsonAtomic(path.join(this.requireDir(), 'ui-state.json'), next);
    return next;
  }

  async cacheExplanation(symbol: SymbolRecord, markdown: string): Promise<void> {
    await writeJsonAtomic(path.join(this.requireDir(), 'explanations', `${symbol.id}.json`), {
      symbolId: symbol.id,
      sourceHash: symbol.sourceHash,
      markdown,
      updatedAt: new Date().toISOString(),
    });
  }

  async getCachedExplanation(symbol: SymbolRecord): Promise<string | null> {
    const cached = await readJson<{ sourceHash: string; markdown: string } | null>(path.join(this.requireDir(), 'explanations', `${symbol.id}.json`), null);
    return cached?.sourceHash === symbol.sourceHash ? cached.markdown : null;
  }

  async cacheSymbolSummary(symbol: SymbolRecord, markdown: string): Promise<void> {
    await writeJsonAtomic(path.join(this.requireDir(), 'symbol-summaries', `${symbol.id}.json`), {
      symbolId: symbol.id,
      sourceHash: symbol.sourceHash,
      markdown,
      updatedAt: new Date().toISOString(),
    });
  }

  async getCachedSymbolSummary(symbol: SymbolRecord): Promise<string | null> {
    const insight = await this.getSymbolInsight(symbol);
    if (insight) return insight.markdown;
    const cached = await readJson<{ sourceHash: string; markdown: string } | null>(path.join(this.requireDir(), 'symbol-summaries', `${symbol.id}.json`), null);
    return cached?.sourceHash === symbol.sourceHash ? cached.markdown : null;
  }

  async getSymbolInsight(symbol: SymbolRecord): Promise<SymbolInsight | null> {
    const catalog = await this.loadSemanticCatalog();
    let cached = catalog.symbols[symbol.id];
    let matchedPreviousId = false;
    if (!cached && this.allowStaleSemantic) {
      const file = (symbol.definition ?? symbol.declaration).file;
      const previousId = Object.entries(catalog.symbolMetadata ?? {}).find(([, metadata]) => metadata.name === symbol.name
        && metadata.kind === symbol.kind && metadata.file === file && metadata.scope === symbol.scope)?.[0];
      cached = previousId ? catalog.symbols[previousId] : undefined;
      matchedPreviousId = Boolean(cached);
    }
    if (!cached) return null;
    if (!matchedPreviousId && cached.sourceHash === symbol.sourceHash) return { ...cached, stale: false };
    return this.allowStaleSemantic ? { ...cached, symbolId: symbol.id, stale: true } : null;
  }

  async getCachedSymbolIds(symbols: SymbolRecord[]): Promise<Set<string>> {
    const catalog = await this.loadSemanticCatalog();
    const staleKeys = new Set(Object.entries(catalog.symbolMetadata ?? {}).filter(([id]) => Boolean(catalog.symbols[id])).map(([, metadata]) => `${metadata.kind}\0${metadata.file}\0${metadata.scope}\0${metadata.name}`));
    return new Set(symbols.filter((symbol) => {
      const cached = catalog.symbols[symbol.id];
      if (cached && (this.allowStaleSemantic || cached.sourceHash === symbol.sourceHash)) return true;
      if (!this.allowStaleSemantic) return false;
      return staleKeys.has(`${symbol.kind}\0${(symbol.definition ?? symbol.declaration).file}\0${symbol.scope}\0${symbol.name}`);
    }).map((symbol) => symbol.id));
  }

  async cacheSymbolInsights(insights: SymbolInsight[]): Promise<void> {
    if (!insights.length) return;
    const catalog = await this.loadSemanticCatalog();
    catalog.symbolMetadata ??= {};
    for (const insight of insights) {
      catalog.symbols[insight.symbolId] = insight;
      const symbol = this.symbolResolver?.(insight.symbolId);
      if (symbol) catalog.symbolMetadata[insight.symbolId] = {
        name: symbol.name,
        kind: symbol.kind,
        file: (symbol.definition ?? symbol.declaration).file,
        scope: symbol.scope,
      };
    }
    await this.saveSemanticCatalog();
  }

  async getProjectInsight(sourceHash: string): Promise<ProjectInsight | null> {
    const insight = (await this.loadSemanticCatalog()).project;
    if (!insight) return null;
    if (insight.sourceHash === sourceHash) return { ...insight, stale: false };
    return this.allowStaleSemantic ? { ...insight, stale: true } : null;
  }

  async cacheProjectInsight(insight: ProjectInsight): Promise<void> {
    const catalog = await this.loadSemanticCatalog();
    catalog.project = insight;
    catalog.sourceHash = insight.sourceHash;
    await this.saveSemanticCatalog();
  }

  setAllowStaleSemantic(allow: boolean): void {
    this.allowStaleSemantic = allow;
  }

  async markSemanticBaseline(sourceHash: string): Promise<void> {
    const catalog = await this.loadSemanticCatalog();
    catalog.sourceHash = sourceHash;
    await this.saveSemanticCatalog();
  }

  async resetSemanticCatalog(): Promise<void> {
    this.requireDir();
    // Finish any already scheduled disk write before replacing the in-memory
    // object, otherwise an older catalog could win the race after reset.
    await this.semanticWrite;
    const empty: SemanticCatalog = { schema: 2, symbols: {} };
    this.semanticCatalog = empty;
    this.semanticLoad = Promise.resolve(empty);
    this.allowStaleSemantic = false;
    this.semanticWrite = writeJsonAtomic(this.semanticFile(), empty);
    await this.semanticWrite;
  }

  async analysisCacheState(symbols: SymbolRecord[], currentHash: string): Promise<AnalysisCacheState> {
    const catalog = await this.loadSemanticCatalog();
    const cachedEntries = Object.values(catalog.symbols);
    const compatibleCount = symbols.filter((symbol) => catalog.symbols[symbol.id]?.sourceHash === symbol.sourceHash).length;
    const currentIds = new Set(symbols.map((symbol) => symbol.id));
    const currentById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    const staleCount = cachedEntries.filter((insight) => {
      const symbol = currentById.get(insight.symbolId);
      return !symbol || symbol.sourceHash !== insight.sourceHash;
    }).length;
    const newCount = symbols.filter((symbol) => !catalog.symbols[symbol.id]).length;
    const savedHash = catalog.sourceHash ?? catalog.project?.sourceHash;
    const hasCache = cachedEntries.length > 0 || Boolean(catalog.project);
    const changed = hasCache && (savedHash ? savedHash !== currentHash : staleCount > 0 || [...currentIds].some((id) => !catalog.symbols[id]));
    return {
      currentHash,
      savedHash,
      hasCache,
      changed,
      cachedCount: cachedEntries.length,
      compatibleCount,
      staleCount,
      newCount,
    };
  }
}
