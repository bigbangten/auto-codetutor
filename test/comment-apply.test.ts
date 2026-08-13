import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectService } from '../src/main/project-service.js';

const runtime = path.resolve('node_modules/web-tree-sitter/web-tree-sitter.wasm');
const grammar = path.resolve('node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-cpp.wasm');
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

test('comment apply creates a backup and blocks non-comment code changes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codetutor-next-comment-'));
  const source = 'int main(void) { return 0; }';
  await writeFile(path.join(root, 'main.c'), source, 'utf8');
  const project = new ProjectService(runtime, grammar);
  t.after(() => { project.dispose(); return rm(root, { recursive: true, force: true }); });
  await project.open(root);

  const blocked = await project.applyGeneratedComments({
    file: 'main.c', startLine: 1, endLine: 1, codeHash: digest(source),
    aiOutput: '```c\nint main(void) { return 1; }\n```',
  });
  assert.equal(blocked.applied, false);
  assert.equal(await readFile(path.join(root, 'main.c'), 'utf8'), source);

  const applied = await project.applyGeneratedComments({
    file: 'main.c', startLine: 1, endLine: 1, codeHash: digest(source),
    aiOutput: '```c\n// 프로그램 진입점: 정상 종료 상태를 반환한다.\nint main(void) { return 0; }\n```',
  });
  assert.equal(applied.applied, true);
  assert.match(applied.backupPath ?? '', /^\.codetutor-next\/comment-backups\//);
  assert.match(await readFile(path.join(root, 'main.c'), 'utf8'), /프로그램 진입점/);
});
