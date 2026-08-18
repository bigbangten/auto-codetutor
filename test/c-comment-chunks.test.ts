import assert from 'node:assert/strict';
import test from 'node:test';
import { splitCommentText } from '../src/shared/c-comment-chunks.js';

test('large comment targets split on lines and reconstruct exactly', () => {
  const source = Array.from({ length: 180 }, (_, index) => index % 12 === 11 ? '}' : `uint32_t value_${index} = ${index}U;`).join('\n');
  const chunks = splitCommentText(source, 1_000);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((chunk) => chunk.text).join('\n'), source);
  assert.equal(chunks[0]?.startLineOffset, 0);
  assert.equal(chunks.at(-1)?.endLineOffset, 179);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 1_000));
});

test('small comment targets remain a single chunk', () => {
  assert.deepEqual(splitCommentText('int main(void)\n{\n  return 0;\n}', 1_000), [{
    text: 'int main(void)\n{\n  return 0;\n}', startLineOffset: 0, endLineOffset: 3,
  }]);
});
