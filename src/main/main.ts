import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AIRequest, AnalysisCacheDecision, AppCommand, AppSettings, CommentApplyRequest, StudyNote, UiState } from '../shared/contracts.js';
import { AIRunner } from './ai-runner.js';
import { validateDocumentAnchors, validateMarkdownAnchors } from './anchors.js';
import { GlobalSettingsStore, LearningStore } from './learning-store.js';
import { ProjectService } from './project-service.js';

let mainWindow: BrowserWindow | null = null;
let project: ProjectService;
let learning: LearningStore;
let settings: GlobalSettingsStore;
let ai: AIRunner;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function sameProjectPath(left: string | undefined | null, right: string | undefined | null): boolean {
  if (!left || !right) return false;
  return path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US');
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function installApplicationMenu(): void {
  const command = (value: AppCommand) => () => send('app:command', value);
  const template: MenuItemConstructorOptions[] = [
    {
      label: '파일',
      submenu: [
        { label: '프로젝트 가져오기…', accelerator: 'CommandOrControl+O', click: command('import-project') },
        { label: '현재 프로젝트 새로고침', accelerator: 'F5', click: command('refresh-active-project') },
        { label: '현재 프로젝트 닫기', accelerator: 'CommandOrControl+W', click: command('close-active-project') },
        { label: '레퍼런스 폴더 지정…', accelerator: 'CommandOrControl+Shift+O', click: command('pick-reference-folder') },
        { label: '학습 노트 내보내기…', click: command('export-notes') },
        { type: 'separator' },
        { label: 'Auto CodeTutor 종료', role: 'quit' },
      ],
    },
    {
      label: '편집',
      submenu: [
        { label: '실행 취소', role: 'undo' },
        { label: '다시 실행', role: 'redo' },
        { type: 'separator' },
        { label: '잘라내기', role: 'cut' },
        { label: '복사', role: 'copy' },
        { label: '붙여넣기', role: 'paste' },
        { label: '모두 선택', role: 'selectAll' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '다시 로드', role: 'reload' },
        { type: 'separator' },
        { label: '확대', role: 'zoomIn' },
        { label: '축소', role: 'zoomOut' },
        { label: '배율 초기화', role: 'resetZoom' },
        { type: 'separator' },
        { label: '전체 화면', role: 'togglefullscreen' },
      ],
    },
    {
      label: '이동',
      submenu: [
        { label: '프로젝트 목록', accelerator: 'CommandOrControl+Shift+E', click: command('focus-projects') },
        { label: '실행 개요', accelerator: 'CommandOrControl+Shift+F', click: command('show-flow') },
        { label: 'AI 질문', accelerator: 'CommandOrControl+Shift+A', click: command('show-chat') },
      ],
    },
    {
      label: '도움말',
      submenu: [
        {
          label: 'Auto CodeTutor 정보',
          click: () => {
            if (!mainWindow) return;
            void dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Auto CodeTutor 정보',
              message: `Auto CodeTutor ${app.getVersion()}`,
              detail: '임베디드 C 프로젝트를 구조·실행 흐름·근거 중심으로 학습하는 로컬 데스크톱 도구입니다. S32DS/NXP 프로젝트에는 MEX·RTD 전용 분석을 추가로 제공합니다.\n\n제작자: 김영민\n이메일: bigbangten95@gmail.com\n\nAI는 설치된 Codex 또는 Claude CLI를 사용하며 API 키를 저장하지 않습니다.',
              buttons: ['확인'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installIpc(): void {
  ipcMain.handle('project:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'], title: '임베디드 C 프로젝트 폴더 선택' });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('project:open', async (_event, rootPath: unknown) => {
    if (typeof rootPath !== 'string' || !rootPath.trim()) throw new Error('프로젝트 경로가 올바르지 않습니다.');
    await ai.cancelBackgroundAnalysis(false);
    await Promise.all(ai.list().filter((job) => job.state === 'queued' || job.state === 'running').map((job) => ai.cancel(job.id)));
    const snapshot = await project.open(rootPath);
    learning.bind(project.projectDataDir!, (id) => project.getSymbol(id));
    const current = await settings.get();
    await settings.save({
      recentProjects: [snapshot.rootPath, ...current.recentProjects.filter((item) => item !== snapshot.rootPath)],
      openProjects: current.openProjects.includes(snapshot.rootPath)
        ? current.openProjects
        : [...current.openProjects, snapshot.rootPath],
      activeProject: snapshot.rootPath,
    });
    return snapshot;
  });
  ipcMain.handle('project:refresh', async () => {
    if (!project.root) throw new Error('새로고침할 프로젝트가 없습니다.');
    return project.refresh();
  });
  ipcMain.handle('project:close', async (_event, rootPath: unknown) => {
    if (typeof rootPath !== 'string' || !rootPath.trim()) throw new Error('닫을 프로젝트 경로가 올바르지 않습니다.');
    const current = await settings.get();
    const closedPath = current.openProjects.find((item) => sameProjectPath(item, rootPath))
      ?? (sameProjectPath(project.root, rootPath) ? project.root : undefined);
    if (!closedPath) throw new Error('열린 프로젝트 목록에서 해당 프로젝트를 찾을 수 없습니다.');
    const closedIndex = current.openProjects.indexOf(closedPath);
    const openProjects = current.openProjects.filter((item) => !sameProjectPath(item, closedPath));
    const activeClosed = sameProjectPath(project.root ?? current.activeProject, closedPath);
    const nextProject = activeClosed
      ? (openProjects.length ? openProjects[Math.min(closedIndex, openProjects.length - 1)] : undefined)
      : current.activeProject;
    if (activeClosed) {
      await ai.resetProjectContext();
      await project.close();
      learning.unbind();
    }
    const nextSettings = await settings.save({
      openProjects,
      activeProject: activeClosed ? nextProject : current.activeProject,
    });
    return { settings: nextSettings, activeClosed, nextProject: activeClosed ? nextProject : undefined };
  });
  ipcMain.handle('project:snapshot', () => project.snapshot());
  ipcMain.handle('source:read', (_event, relativePath: unknown) => {
    if (typeof relativePath !== 'string') throw new Error('파일 경로가 올바르지 않습니다.');
    return project.readSource(relativePath);
  });
  ipcMain.handle('symbol:at', (_event, input: unknown) => {
    const value = input as { file?: unknown; line?: unknown; column?: unknown; word?: unknown };
    if (typeof value?.file !== 'string' || typeof value.word !== 'string' || !Number.isInteger(value.line) || !Number.isInteger(value.column)) return null;
    return project.getSymbolAt({ file: value.file, word: value.word, line: Number(value.line), column: Number(value.column) });
  });
  ipcMain.handle('symbol:get', (_event, id: unknown) => typeof id === 'string' ? project.getSymbol(id) : null);
  ipcMain.handle('graph:get', (_event, input: unknown) => project.currentIndex?.graph((input && typeof input === 'object' ? input : {}) as { rootId?: string; query?: string; limit?: number }) ?? { nodes: [], edges: [], roots: [], truncated: false, limitations: [] });
  ipcMain.handle('anchors:validate', async (_event, markdown: unknown) => {
    if (!project.root || typeof markdown !== 'string') return [];
    return [
      ...(await validateMarkdownAnchors(project.root, markdown)),
      ...validateDocumentAnchors(markdown, (name, page) => project.references.hasDocument(name, page)),
    ];
  });
  ipcMain.handle('reference:pick', async () => {
    if (!project.root) throw new Error('프로젝트를 먼저 여세요.');
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'], title: '데이터시트·레퍼런스 폴더 선택' });
    return result.canceled || !result.filePaths[0] ? null : project.setReferenceFolder(result.filePaths[0]);
  });
  ipcMain.handle('reference:get', () => project.referenceStatus());
  ipcMain.handle('reference:clear', () => project.clearReferenceFolder());
  ipcMain.handle('reference:open', async (_event, input: { name?: unknown; page?: unknown }) => {
    if (typeof input?.name !== 'string' || !Number.isInteger(input.page) || !project.references.hasDocument(input.name, Number(input.page))) return false;
    const target = await project.references.resolveDocument(input.name);
    await shell.openExternal(`${pathToFileURL(target).href}#page=${Number(input.page)}`);
    return true;
  });
  ipcMain.handle('ai:engines', () => ai.engines());
  ipcMain.handle('ai:start', (_event, request: AIRequest) => ai.start(request));
  ipcMain.handle('semantic:start', () => ai.startBackgroundAnalysis());
  ipcMain.handle('semantic:restart', () => ai.restartBackgroundAnalysis());
  ipcMain.handle('semantic:cancel', () => ai.cancelBackgroundAnalysis());
  ipcMain.handle('semantic:status', () => ai.backgroundStatus());
  ipcMain.handle('semantic:cache-state', () => {
    if (!project.root) throw new Error('프로젝트를 먼저 여세요.');
    return learning.analysisCacheState(project.semanticTargets(), project.semanticSourceHash());
  });
  ipcMain.handle('semantic:cache-mode', async (_event, input: AnalysisCacheDecision) => {
    if (!project.root || !input || !['keep', 'update'].includes(input.mode) || input.sourceHash !== project.semanticSourceHash()) {
      throw new Error('분석 캐시 선택을 적용할 수 없습니다. 프로젝트가 다시 변경되었을 수 있습니다.');
    }
    await ai.cancelBackgroundAnalysis(false);
    learning.setAllowStaleSemantic(input.mode === 'keep');
    if (input.mode === 'update') await learning.markSemanticBaseline(input.sourceHash);
  });
  ipcMain.handle('semantic:analyze-symbol', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('심볼 ID가 올바르지 않습니다.');
    return ai.analyzeSymbol(id);
  });
  ipcMain.handle('semantic:symbol', (_event, id: unknown) => typeof id === 'string' ? ai.symbolInsight(id) : null);
  ipcMain.handle('semantic:project', () => ai.projectInsight());
  ipcMain.handle('ai:cancel', (_event, id: unknown) => typeof id === 'string' && ai.cancel(id));
  ipcMain.handle('ai:list', () => ai.list());
  ipcMain.handle('chat:list', () => learning.listChats());
  ipcMain.handle('chat:get', (_event, id: unknown) => typeof id === 'string' ? learning.getChat(id) : null);
  ipcMain.handle('chat:delete', (_event, id: unknown) => typeof id === 'string' && learning.deleteChat(id));
  ipcMain.handle('note:list', () => learning.listNotes());
  ipcMain.handle('note:save', (_event, note: Partial<StudyNote> & Pick<StudyNote, 'title' | 'body'>) => learning.saveNote(note));
  ipcMain.handle('note:delete', (_event, id: unknown) => typeof id === 'string' && learning.deleteNote(id));
  ipcMain.handle('note:export', async () => {
    if (!project.root) return { canceled: true };
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '학습 노트 내보내기',
      defaultPath: `${path.basename(project.root)}_학습노트_${new Date().toISOString().slice(0, 10)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await writeFile(result.filePath, await learning.notesMarkdown(), 'utf8');
    return { canceled: false, path: result.filePath };
  });
  ipcMain.handle('quiz:list', (_event, symbolId: unknown) => learning.listQuizzes(typeof symbolId === 'string' ? symbolId : undefined));
  ipcMain.handle('quiz:answer', (_event, input: { quizId: string; questionId: string; answer: string }) => learning.answerQuiz(input));
  ipcMain.handle('ui:get', () => learning.getUiState());
  ipcMain.handle('ui:save', (_event, state: Partial<UiState>) => learning.saveUiState(state));
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:save', (_event, changes: Partial<AppSettings>) => settings.save(changes));
  ipcMain.handle('comments:apply', (_event, request: CommentApplyRequest) => project.applyGeneratedComments(request));
}

async function createWindow(): Promise<void> {
  const assetsDir = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(app.getAppPath(), 'assets');
  project = new ProjectService(path.join(assetsDir, 'tree-sitter.wasm'), path.join(assetsDir, 'tree-sitter-c.wasm'));
  learning = new LearningStore();
  settings = new GlobalSettingsStore(app.getPath('userData'));
  ai = new AIRunner(project, learning);
  await mkdir(path.join(app.getPath('userData'), 'codetutor-next'), { recursive: true });
  // Deterministic UI smoke tests can open a fixture without automating the native folder dialog.
  // This environment variable is never set by packaged user sessions.
  const smokeProject = process.env.CODETUTOR_NEXT_E2E_PROJECT;
  if (smokeProject && process.env.CODETUTOR_NEXT_E2E_DISABLE_AI === '1') {
    await settings.save({ autoAnalyzeSymbols: false });
  }
  if (smokeProject) {
    await project.open(smokeProject);
    learning.bind(project.projectDataDir!, (id) => project.getSymbol(id));
  }

  mainWindow = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    title: 'Auto CodeTutor',
    icon: path.join(assetsDir, 'app-icon.png'),
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(moduleDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  installApplicationMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  project.onUpdated((snapshot) => {
    send('project:index-updated', snapshot);
  });
  ai.onEvent((event) => send('ai:event', event));
  ai.onBackgroundAnalysis((status) => send('semantic:event', status));
  installIpc();
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  await mainWindow.loadFile(path.join(moduleDir, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

if (process.platform === 'win32') app.setAppUserModelId('com.bigbangten.auto-codetutor');
app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('Auto CodeTutor 시작 실패', (error as Error).stack || (error as Error).message);
  app.quit();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => project?.dispose());
app.on('activate', () => { if (!mainWindow) void createWindow(); });
