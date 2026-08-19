import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInvocation, extractJsonText, parseProjectInsightOutput, parseSymbolInsightOutput, parseWindowsShim } from '../src/main/ai-runner.js';
import type { AIRequest, SymbolRecord } from '../src/shared/contracts.js';

const base: AIRequest = { kind: 'explain', engine: 'codex', model: 'default', effort: 'high', fast: true, symbolId: 'symbol' };

test('Codex invocation is stdin-driven, ephemeral, and read-only', () => {
  const invocation = buildInvocation(base, 'D:/project', 'codex.exe');
  assert.equal(invocation.command, 'codex.exe');
  assert.ok(invocation.args.includes('read-only'));
  assert.ok(invocation.args.includes('--ephemeral'));
  assert.ok(invocation.args.includes('--ignore-rules'));
  assert.equal(invocation.args.at(-1), '-');
  assert.ok(invocation.args.some((arg) => arg.includes('service_tier')));
});

test('Claude invocation disables customizations and exposes read tools only', () => {
  const invocation = buildInvocation({ ...base, engine: 'claude', model: 'sonnet', fast: false }, 'D:/project', 'claude.exe');
  assert.ok(invocation.args.includes('--safe-mode'));
  assert.ok(invocation.args.includes('plan'));
  assert.ok(invocation.args.includes('Read,Glob,Grep'));
  assert.equal(invocation.args.includes('Edit'), false);
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--model'), invocation.args.indexOf('--model') + 2), ['--model', 'sonnet']);
});

test('Windows npm shims resolve to node + JS or their native executable without cmd.exe', () => {
  const codex = parseWindowsShim('C:/npm/codex.cmd', '@echo off\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', 'C:/node/node.exe');
  assert.deepEqual(codex, { command: 'C:/node/node.exe', prefix: ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'] });
  const claude = parseWindowsShim('C:/bin/claude.cmd', '@echo off\n"C:\\tools\\claude.exe" %*', 'node.exe');
  assert.deepEqual(claude, { command: 'C:\\tools\\claude.exe', prefix: [] });
});

test('Codex completed agent messages replace progress text so the last answer wins', () => {
  const progress = extractJsonText('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '조사하겠습니다.' } }));
  const answer = extractJsonText('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '최종 분석' } }));
  assert.equal(progress.replace, true);
  assert.equal(answer.replace, true);
  let output = '';
  for (const event of [progress, answer]) output = event.replace ? event.text : `${output}${event.text}`;
  assert.equal(output, '최종 분석');
});

test('프로젝트 목적 JSON을 사용자 기능 단계로 구조화한다', () => {
  const output = '```json\n{"purpose":"SQI를 측정해 케이블 상태를 전송한다.","stages":[{"title":"SQI 측정","summary":"PHY 품질 값을 읽는다.","focus":"user","symbols":["MeasureSqi"]},{"title":"진단 전송","summary":"Ethernet 메시지로 보낸다.","focus":"mixed","symbols":["SendDiagnosis"]}]}\n```';
  const insight = parseProjectInsightOutput(output, 'hash', 'gpt-5.6-terra');
  assert.equal(insight.purpose, 'SQI를 측정해 케이블 상태를 전송한다.');
  assert.equal(insight.stages[1]?.focus, 'mixed');
  assert.deepEqual(insight.stages[0]?.symbols, ['MeasureSqi']);
});

test('배치 심볼 JSON의 필드 의미와 코드 근거를 캐시 형식으로 변환한다', () => {
  const range = { file: 'src/app.c', startLine: 12, startColumn: 1, endLine: 12, endColumn: 8 };
  const symbol: SymbolRecord = {
    id: 'variable:data', name: 'data', kind: 'variable', type: 'Frame_t', scope: 'SendFrame',
    declaration: range, definition: range, parameters: [], returnExpressions: [], fields: [], origin: { kind: 'unknown', label: '프로젝트 코드', confidence: 'limited', rule: 'test', anchors: [range] },
    references: [], calls: [], callers: [], sourceHash: 'source', limitations: [],
  };
  const output = JSON.stringify({ symbols: [{ id: symbol.id, meaning: '전송 프레임을 담는다.', typeDescription: '프레임 데이터 구조체다.', returnDescription: '반환값 없음', impact: '길이를 바꾸면 송신 크기가 달라진다.', caveat: '런타임 값 확인 필요', fields: [{ path: 'data_length', description: '유효 페이로드 바이트 수' }] }] });
  const [insight] = parseSymbolInsightOutput(output, [symbol], 'gpt-5.6-terra');
  assert.equal(insight?.fieldDescriptions.data_length, '유효 페이로드 바이트 수');
  assert.equal(insight?.typeDescription, '프레임 데이터 구조체다.');
  assert.match(insight?.markdown ?? '', /\[\[src\/app\.c:12\]\]/);
  assert.doesNotMatch(insight?.markdown ?? '', /입력과 반환/, '입력/반환은 구조화 UI에서 한 번만 표시해야 함');
});
