import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisProcessedCount, analysisProgressLabel, analysisProgressPercent } from '../src/shared/analysis-progress.js';

test('analysis gauge and label use the same processed count', () => {
  const status = { total: 9_347, completed: 0, failed: 2_946 };
  assert.equal(analysisProcessedCount(status), 2_946);
  assert.equal(analysisProgressPercent(status), 2_946 / 9_347 * 100);
  assert.match(analysisProgressLabel(status), /^2,946\/9,347 처리/);
  assert.match(analysisProgressLabel(status), /완료 0 · 실패 2,946/);
});

test('successful progress stays concise and is capped at the total', () => {
  const status = { total: 10, completed: 12, failed: 0 };
  assert.equal(analysisProcessedCount(status), 10);
  assert.equal(analysisProgressPercent(status), 100);
  assert.equal(analysisProgressLabel(status), '10/10 처리');
});
