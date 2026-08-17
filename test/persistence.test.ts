import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GlobalSettingsStore, LearningStore } from '../src/main/learning-store.js';
import type { SymbolInsight, SymbolRecord } from '../src/shared/contracts.js';

function symbol(sourceHash: string, id = 'function:main'): SymbolRecord {
  const range = { file: 'src/main.c', startLine: 3, startColumn: 1, endLine: 3, endColumn: 10 };
  return {
    id, name: 'main', kind: 'function', type: 'int', scope: 'global', declaration: range, definition: range,
    parameters: [], returnExpressions: ['0'], fields: [], origin: { kind: 'unknown', label: 'project', confidence: 'limited', rule: 'test', anchors: [range] },
    references: [], calls: [], callers: [], sourceHash, limitations: [],
  };
}

function insight(sourceHash: string, symbolId = 'function:main'): SymbolInsight {
  return {
    symbolId, sourceHash, meaning: '시작점', typeDescription: '정수 반환', parameterDescriptions: {}, returnDescription: '종료 상태',
    impact: '전체 실행', caveat: '정적 분석', markdown: '설명', fieldDescriptions: {}, model: 'gpt-5.6-terra', updatedAt: new Date().toISOString(),
  };
}

test('semantic cache survives a new LearningStore instance and can deliberately expose stale explanations', async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'codetutor-cache-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const oldSymbol = symbol('old-source');
  const first = new LearningStore(); first.bind(data, () => oldSymbol);
  await first.markSemanticBaseline('old-project');
  await first.cacheSymbolInsights([insight('old-source')]);

  const currentSymbol = symbol('new-source');
  const reopened = new LearningStore(); reopened.bind(data, () => currentSymbol);
  const state = await reopened.analysisCacheState([currentSymbol], 'new-project');
  assert.equal(state.hasCache, true);
  assert.equal(state.changed, true);
  assert.equal(await reopened.getSymbolInsight(currentSymbol), null);
  reopened.setAllowStaleSemantic(true);
  assert.equal((await reopened.getSymbolInsight(currentSymbol))?.stale, true);
});

test('kept analysis follows the same named symbol when line movement changes its index id', async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'codetutor-cache-alias-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const oldSymbol = symbol('old-source', 'old-id');
  const first = new LearningStore(); first.bind(data, (id) => id === oldSymbol.id ? oldSymbol : null);
  await first.cacheSymbolInsights([insight('old-source', oldSymbol.id)]);
  const movedSymbol = symbol('new-source', 'new-id');
  const reopened = new LearningStore(); reopened.bind(data, () => movedSymbol); reopened.setAllowStaleSemantic(true);
  const restored = await reopened.getSymbolInsight(movedSymbol);
  assert.equal(restored?.symbolId, movedSymbol.id);
  assert.equal(restored?.stale, true);
});

test('full semantic reset removes project and symbol AI cache without touching other learning data', async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'codetutor-cache-reset-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const current = symbol('source');
  const store = new LearningStore(); store.bind(data, () => current);
  await store.markSemanticBaseline('project');
  await store.cacheSymbolInsights([insight('source')]);
  await store.appendChat(undefined, 'user', '기록 유지 확인');
  await store.resetSemanticCatalog();
  assert.equal(await store.getSymbolInsight(current), null);
  assert.equal((await store.analysisCacheState([current], 'project')).hasCache, false);
  assert.equal((await store.listChats()).length, 1);
});

test('global settings retain several open projects and the active project', async (t) => {
  const appData = await mkdtemp(path.join(os.tmpdir(), 'codetutor-settings-'));
  t.after(() => rm(appData, { recursive: true, force: true }));
  const settings = new GlobalSettingsStore(appData);
  await settings.save({ openProjects: ['D:/one', 'D:/two'], activeProject: 'D:/two', recentProjects: ['D:/two', 'D:/one'] });
  const reopened = new GlobalSettingsStore(appData);
  assert.deepEqual((await reopened.get()).openProjects, ['D:/one', 'D:/two']);
  assert.equal((await reopened.get()).activeProject, 'D:/two');
  assert.equal((await reopened.get()).commentModel, 'gpt-5.6-sol');
  assert.equal((await reopened.get()).commentEffort, 'medium');
});

test('global settings allow the final open project to be closed', async (t) => {
  const appData = await mkdtemp(path.join(os.tmpdir(), 'codetutor-settings-close-'));
  t.after(() => rm(appData, { recursive: true, force: true }));
  const settings = new GlobalSettingsStore(appData);

  await settings.save({ openProjects: ['D:/only'], activeProject: 'D:/only' });
  const closed = await settings.save({ openProjects: [], activeProject: undefined });

  assert.deepEqual(closed.openProjects, []);
  assert.equal(closed.activeProject, undefined);
  const reopened = await new GlobalSettingsStore(appData).get();
  assert.deepEqual(reopened.openProjects, []);
  assert.equal(reopened.activeProject, undefined);
});

test('chat threads and the last selected chat survive reopening the project store', async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'codetutor-chat-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const first = new LearningStore(); first.bind(data, () => null);
  const chat = await first.appendChat(undefined, 'user', '이 프로젝트의 목적은 무엇인가?');
  await first.appendChat(chat.id, 'assistant', '진단 값을 측정해 전송하는 프로젝트입니다.');
  await first.saveUiState({ lastChatId: chat.id });
  const reopened = new LearningStore(); reopened.bind(data, () => null);
  assert.equal((await reopened.getUiState()).lastChatId, chat.id);
  assert.equal((await reopened.getChat(chat.id))?.messages.length, 2);
});
