import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../src/main/project-service.js';
import { prioritizeSemanticTargets } from '../src/main/ai-runner.js';

const runtime = path.resolve('node_modules/web-tree-sitter/web-tree-sitter.wasm');
const grammar = path.resolve('node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-cpp.wasm');

test('background semantic targets cover every symbol used in src regardless of origin', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codetutor-semantic-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'main.c'), `
    /* NXP RTD example notice */
    #define UDP_PORT 5004U
    static status_t Send(uint8_t port) {
      return SDK_Send(port, UDP_PORT);
    }
  `, 'utf8');
  const project = new ProjectService(runtime, grammar);
  t.after(() => { project.dispose(); return rm(root, { recursive: true, force: true }); });
  await project.open(root);
  const targets = project.semanticTargets();
  const names = new Set(targets.map((symbol) => symbol.name));
  for (const expected of ['UDP_PORT', 'Send', 'port', 'status_t', 'uint8_t', 'SDK_Send']) assert.ok(names.has(expected), `${expected}가 사전 분석 대상에서 빠졌습니다.`);
  assert.ok(targets.some((symbol) => symbol.name === 'UDP_PORT' && symbol.kind === 'macro'));
  assert.ok(targets.some((symbol) => symbol.name === 'SDK_Send' && symbol.synthetic === 'external-symbol'));
  const prioritized = prioritizeSemanticTargets(targets);
  assert.ok(prioritized.findIndex((symbol) => symbol.name === 'Send') < prioritized.findIndex((symbol) => symbol.name === 'SDK_Send'), 'src의 실제 정의가 외부 미해결 심볼보다 먼저 분석되어야 합니다.');
});

test('closing a project detaches its index and allows another project to open cleanly', async (t) => {
  const first = await mkdtemp(path.join(os.tmpdir(), 'auto-codetutor-close-first-'));
  const second = await mkdtemp(path.join(os.tmpdir(), 'auto-codetutor-close-second-'));
  await Promise.all([
    mkdir(path.join(first, 'src')),
    mkdir(path.join(second, 'src')),
  ]);
  await Promise.all([
    writeFile(path.join(first, 'src', 'main.c'), 'int FirstProject(void) { return 1; }\n', 'utf8'),
    writeFile(path.join(second, 'src', 'main.c'), 'int SecondProject(void) { return 2; }\n', 'utf8'),
  ]);
  const project = new ProjectService(runtime, grammar);
  t.after(async () => {
    project.dispose();
    await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
  });
  await project.open(first);
  assert.ok(project.snapshot()?.symbols.some((symbol) => symbol.name === 'FirstProject'));
  await project.close();
  assert.equal(project.root, null);
  assert.equal(project.snapshot(), null);
  await project.open(second);
  assert.ok(project.snapshot()?.symbols.some((symbol) => symbol.name === 'SecondProject'));
  assert.ok(!project.snapshot()?.symbols.some((symbol) => symbol.name === 'FirstProject'));
});
