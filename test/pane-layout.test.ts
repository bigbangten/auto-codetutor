import assert from 'node:assert/strict';
import test from 'node:test';
import { clampDraggedPaneWidth, clampPaneWidths, PANE_LAYOUT_LIMITS } from '../src/shared/pane-layout.js';

test('saved pane widths always preserve a usable center editor', () => {
  const widths = clampPaneWidths(1000, 520, 720);
  assert.equal(widths.left, 292);
  assert.equal(widths.right, 340);
  assert.ok(1000 - widths.left - widths.right - PANE_LAYOUT_LIMITS.splitterTotal >= PANE_LAYOUT_LIMITS.centerMinimum);
});

test('dragging is bounded without changing the opposite pane', () => {
  assert.equal(clampDraggedPaneWidth(1540, 'right', 1200, 280), 720);
  assert.equal(clampDraggedPaneWidth(1000, 'right', 720, 220), 412);
  assert.equal(clampDraggedPaneWidth(1000, 'left', 700, 340), 292);
});
