import assert from 'node:assert/strict';
import test from 'node:test';
import { removeCComments } from '../src/shared/c-comments.js';

test('all-comment removal preserves code literals and token separation', () => {
  const source = [
    'int/**/value = 1; // 설명',
    'const char *url = "https://example.test/a/*b*/";',
    "char slash = '/'; /* 여러 줄",
    '주석 */ return value;',
    'const char *raw = R"tag(// 그대로 /* 유지 */)tag";',
  ].join('\n');
  const result = removeCComments(source);
  assert.match(result, /int value = 1;/);
  assert.match(result, /https:\/\/example\.test\/a\/\*b\*\//);
  assert.match(result, /char slash = '\/';/);
  assert.match(result, /return value;/);
  assert.match(result, /R"tag\(\/\/ 그대로 \/\* 유지 \*\/\)tag"/);
  assert.equal(result.split('\n').length, source.split('\n').length);
  assert.doesNotMatch(result, /설명|여러 줄|주석 \*\//);
});
