import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseAnchors, validateDocumentAnchors, validateMarkdownAnchors } from '../src/main/anchors.js';

test('relative line anchors validate and traversal fails closed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codetutor-next-anchor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'main.c'), 'one\ntwo\nthree\n');
  const markdown = '근거 [[src/main.c:2-3]], 잘못된 줄 [[src/main.c:9]], 탈출 [[../secret.c:1]]';
  assert.equal(parseAnchors(markdown).length, 3);
  const result = await validateMarkdownAnchors(root, markdown);
  assert.deepEqual(result.map((item) => item.valid), [true, false, false]);
  assert.equal(result[0]?.range?.file, 'src/main.c');
});

test('reference page anchors are validated independently from code lines', () => {
  const result = validateDocumentAnchors('문서 근거 [[datasheets/S32G.pdf:p.37]] [[missing.pdf:p.2]]', (name, page) => name === 'datasheets/S32G.pdf' && page === 37);
  assert.deepEqual(result.map((item) => item.valid), [true, false]);
  assert.deepEqual(result[0]?.document, { name: 'datasheets/S32G.pdf', page: 37 });
});
