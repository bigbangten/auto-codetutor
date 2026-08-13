import { contextBridge, ipcRenderer } from 'electron';
import type { AIJobEvent, AppCommand, BackgroundAnalysisStatus, CodeTutorApi, ProjectSnapshot } from '../shared/contracts.js';

const invoke = <T>(channel: string, value?: unknown): Promise<T> => ipcRenderer.invoke(channel, value) as Promise<T>;

const api: CodeTutorApi = {
  pickProject: () => invoke('project:pick'),
  openProject: (rootPath) => invoke('project:open', rootPath),
  closeProject: (rootPath) => invoke('project:close', rootPath),
  getSnapshot: () => invoke('project:snapshot'),
  readSource: (relativePath) => invoke('source:read', relativePath),
  getSymbolAt: (input) => invoke('symbol:at', input),
  getSymbol: (symbolId) => invoke('symbol:get', symbolId),
  getGraph: (input) => invoke('graph:get', input),
  validateAnchors: (markdown) => invoke('anchors:validate', markdown),
  pickReferenceFolder: () => invoke('reference:pick'),
  getReferenceFolder: () => invoke('reference:get'),
  clearReferenceFolder: () => invoke('reference:clear'),
  openReference: (input) => invoke('reference:open', input),
  getEngines: () => invoke('ai:engines'),
  startAI: (request) => invoke('ai:start', request),
  startBackgroundAnalysis: () => invoke('semantic:start'),
  restartBackgroundAnalysis: () => invoke('semantic:restart'),
  cancelBackgroundAnalysis: () => invoke('semantic:cancel'),
  getBackgroundAnalysisStatus: () => invoke('semantic:status'),
  getAnalysisCacheState: () => invoke('semantic:cache-state'),
  setAnalysisCacheMode: (decision) => invoke('semantic:cache-mode', decision),
  analyzeSymbol: (symbolId) => invoke('semantic:analyze-symbol', symbolId),
  getSymbolInsight: (symbolId) => invoke('semantic:symbol', symbolId),
  getProjectInsight: () => invoke('semantic:project'),
  cancelAI: (jobId) => invoke('ai:cancel', jobId),
  listJobs: () => invoke('ai:list'),
  listChats: () => invoke('chat:list'),
  getChat: (chatId) => invoke('chat:get', chatId),
  deleteChat: (chatId) => invoke('chat:delete', chatId),
  listNotes: () => invoke('note:list'),
  saveNote: (note) => invoke('note:save', note),
  deleteNote: (noteId) => invoke('note:delete', noteId),
  exportNotes: () => invoke('note:export'),
  listQuizzes: (symbolId) => invoke('quiz:list', symbolId),
  answerQuiz: (input) => invoke('quiz:answer', input),
  getUiState: () => invoke('ui:get'),
  saveUiState: (state) => invoke('ui:save', state),
  getSettings: () => invoke('settings:get'),
  saveSettings: (settings) => invoke('settings:save', settings),
  applyGeneratedComments: (request) => invoke('comments:apply', request),
  onJobEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AIJobEvent) => listener(payload);
    ipcRenderer.on('ai:event', wrapped);
    return () => ipcRenderer.off('ai:event', wrapped);
  },
  onBackgroundAnalysis: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: BackgroundAnalysisStatus) => listener(payload);
    ipcRenderer.on('semantic:event', wrapped);
    return () => ipcRenderer.off('semantic:event', wrapped);
  },
  onIndexUpdated: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ProjectSnapshot) => listener(payload);
    ipcRenderer.on('project:index-updated', wrapped);
    return () => ipcRenderer.off('project:index-updated', wrapped);
  },
  onAppCommand: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, command: AppCommand) => listener(command);
    ipcRenderer.on('app:command', wrapped);
    return () => ipcRenderer.off('app:command', wrapped);
  },
};

contextBridge.exposeInMainWorld('codeTutor', api);
