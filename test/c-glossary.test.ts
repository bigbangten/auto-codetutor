import assert from 'node:assert/strict';
import test from 'node:test';
import { describeCToken, isDirectNumericLiteral } from '../src/shared/c-glossary.js';

test('common C constructs are explained deterministically without an AI request', () => {
  assert.match(describeCToken('volatile')?.summary ?? '', /메모리/);
  assert.match(describeCToken('include', '#include <stdint.h>', 3)?.title ?? '', /include/);
  assert.match(describeCToken('define', '#define UDP_PORT 5004U', 3)?.title ?? '', /define/);
  assert.match(describeCToken('->')?.summary ?? '', /포인터/);
  assert.match(describeCToken('uint16_t')?.summary ?? '', /16비트/);
});

test('direct numeric literals are deliberately excluded from the explanation panel', () => {
  for (const value of ['42', '5004U', '0x80UL', '3.14f', '1e-3']) assert.equal(isDirectNumericLiteral(value), true, value);
  assert.equal(describeCToken('5004U'), null);
});

test('a preprocessor directive is distinct from the macro or header that follows it', () => {
  const directive = describeCToken('define', '#define UDP_PORT 5004U', 3);
  const macro = describeCToken('UDP_PORT', '#define UDP_PORT 5004U', 12);
  const header = describeCToken('stdint', '#include <stdint.h>', 12);
  assert.equal(directive?.category, '전처리 지시문');
  assert.equal(macro?.category, '프로젝트/외부 식별자');
  assert.equal(header?.category, '프로젝트/외부 식별자');
});
