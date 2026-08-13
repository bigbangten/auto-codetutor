import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFlowOverview } from '../src/renderer/graph.js';
import type { CallGraph, GraphNode, ProjectInsight } from '../src/shared/contracts.js';

function node(id: string, name: string, line: number, kind: GraphNode['kind'] = 'function'): GraphNode {
  return { id, name, file: 'src/app.c', line, kind, origin: 'unknown' };
}

test('실행 개요는 외부 호출을 숨기고 최대 5단계로 축약하며 현재 코드 위치를 찾는다', () => {
  const nodes = [
    node('n0', 'main', 1, 'entry'),
    node('n1', 'System_Init', 10),
    node('n2', 'Read_Status', 20),
    node('n3', 'Process_Task', 30),
    node('n4', 'Update_Result', 40),
    node('n5', 'Write_Output', 50),
    node('n6', 'Helper_Finalize', 60),
    node('external:SDK_Call', 'SDK_Call', 0, 'external'),
  ];
  const graph: CallGraph = {
    nodes,
    edges: [
      ['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3'], ['n3', 'n4'], ['n4', 'n5'], ['n5', 'n6'], ['n5', 'external:SDK_Call'],
    ].map(([from, to], index) => ({
      from: from!, to: to!, resolved: !to!.startsWith('external:'),
      range: { file: 'src/app.c', startLine: index + 1, startColumn: 1, endLine: index + 1, endColumn: 2 },
    })),
    roots: ['n0'],
    truncated: false,
    limitations: [],
  };

  const overview = buildFlowOverview(graph, 'n5');
  assert.ok(overview.stages.length <= 5);
  assert.equal(overview.unresolvedCount, 1);
  assert.equal(overview.stages.some((stage) => stage.nodes.some((item) => item.kind === 'external')), false);
  assert.equal(overview.location?.node.name, 'Write_Output');
  assert.equal(overview.stages[0]?.title, '실행 진입');
});

test('AI 목적 분석이 있으면 함수명이 아닌 사용자 기능 단계와 SRC 초점을 사용한다', () => {
  const graph: CallGraph = {
    nodes: [node('main', 'main', 1, 'entry'), node('measure', 'ReadSqi', 10), { ...node('driver', 'Eth_Send', 20), file: 'RTD/src/Eth.c', origin: 'rtd' }],
    edges: [
      { from: 'main', to: 'measure', resolved: true, range: { file: 'src/app.c', startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 } },
      { from: 'measure', to: 'driver', resolved: true, range: { file: 'src/app.c', startLine: 11, startColumn: 1, endLine: 11, endColumn: 2 } },
    ], roots: ['main'], truncated: false, limitations: [],
  };
  const insight: ProjectInsight = {
    sourceHash: 'hash', purpose: 'SQI를 측정해 진단 결과를 전송합니다.', model: 'gpt-5.6-terra', updatedAt: new Date().toISOString(),
    stages: [
      { title: 'SQI 품질 측정', summary: 'PHY 상태를 읽습니다.', focus: 'user' },
      { title: '진단 결과 전송', summary: '외부로 결과를 보냅니다.', focus: 'mixed' },
    ],
  };
  const overview = buildFlowOverview(graph, 'measure', insight);
  assert.equal(overview.stages[0]?.title, 'SQI 품질 측정');
  assert.equal(overview.stages[0]?.focus, 'user');
  assert.equal(overview.location?.node.name, 'ReadSqi');
});
