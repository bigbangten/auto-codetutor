import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCIntegerExpression, evaluateCIntegerExpression } from '../src/shared/c-integer-expression.js';

test('evaluates a safe subset of C integer constant expressions', () => {
  assert.equal(evaluateCIntegerExpression('((1 << 0UL) | (1 << 1UL) | (1 << 2UL))'), 7n);
  assert.equal(evaluateCIntegerExpression('(0x10U + 2U) * 3'), 54n);
  assert.equal(evaluateCIntegerExpression('077U'), 63n);
  assert.equal(evaluateCIntegerExpression('~0U'), -1n);
});

test('rejects identifiers, casts, calls and invalid arithmetic', () => {
  assert.equal(evaluateCIntegerExpression('PORT_A | 1U'), undefined);
  assert.equal(evaluateCIntegerExpression('(uint16_t)(1U << 4)'), undefined);
  assert.equal(evaluateCIntegerExpression('BIT(3)'), undefined);
  assert.equal(evaluateCIntegerExpression('1 / 0'), undefined);
});

test('chooses binary first for a compact bit mask', () => {
  assert.equal(
    calculateCIntegerExpression('(1U << 0) | (1U << 1) | (1U << 2)')?.display,
    '0b111 (2진수) · 7 (10진수) · 0x7 (16진수)',
  );
});
