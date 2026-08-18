import assert from 'node:assert/strict';
import test from 'node:test';
import { expandObjectLikeMacros } from '../src/shared/c-macros.js';

test('object-like macros expand recursively without touching literals or comments', () => {
  const definitions = new Map([
    ['PORT', '500U'],
    ['NEXT', '(PORT + 1U)'],
  ]);
  assert.equal(
    expandObjectLikeMacros('PORT + "PORT" + /* PORT */ NEXT', (name) => definitions.get(name)),
    '500U + "PORT" + /* PORT */ (500U + 1U)',
  );
});

test('cyclic macro definitions stop safely', () => {
  const definitions = new Map([['A', 'B'], ['B', 'A']]);
  assert.equal(expandObjectLikeMacros('A', (name) => definitions.get(name)), 'A');
});
