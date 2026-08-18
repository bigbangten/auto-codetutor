import assert from 'node:assert/strict';
import test from 'node:test';
import { nearestGroundedBlock } from '../src/shared/grounding.js';

test('grounding keeps explanation blocks within their nearest heading section', () => {
  const sections = [0, 0, 0, 1, 1, 1, 1];
  const grounded = [0, 2, 5];
  assert.equal(nearestGroundedBlock(1, grounded, sections), 0, 'a tie prefers the preceding context');
  assert.equal(nearestGroundedBlock(3, grounded, sections), 5, 'a section heading uses the next local evidence');
  assert.equal(nearestGroundedBlock(6, grounded, sections), 5);
});

test('grounding falls back to the nearest verified evidence when a section has none', () => {
  const sections = [0, 0, 1, 1];
  assert.equal(nearestGroundedBlock(3, [1], sections), 1);
  assert.equal(nearestGroundedBlock(0, [], sections), undefined);
  assert.equal(nearestGroundedBlock(-1, [1], sections), undefined);
});
