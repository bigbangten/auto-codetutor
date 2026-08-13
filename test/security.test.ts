import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { isPathInside, resolveRelative } from '../src/main/security.js';

test('project boundary rejects siblings and traversal', () => {
  const root = path.resolve('D:/workspace/project');
  assert.equal(isPathInside(root, path.join(root, 'src/main.c')), true);
  assert.equal(isPathInside(root, path.resolve('D:/workspace/project-copy/main.c')), false);
  assert.throws(() => resolveRelative(root, '../outside.c'), /프로젝트 밖/);
  assert.throws(() => resolveRelative(root, path.resolve(root, 'src/main.c')), /상대 경로/);
});
