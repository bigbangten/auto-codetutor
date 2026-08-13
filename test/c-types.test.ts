import assert from 'node:assert/strict';
import test from 'node:test';
import { describeCType } from '../src/shared/c-types.js';

test('fixed-width and SDK C types have immediate Korean explanations', () => {
  assert.match(describeCType('uint8_t'), /8비트 부호 없는 정수/);
  assert.match(describeCType('uint8_t'), /255/);
  assert.match(describeCType('status_t'), /성공·실패 상태 코드/);
  assert.match(describeCType('err_t'), /lwIP/);
});

test('pointer, const, volatile and array meaning is retained', () => {
  assert.match(describeCType('const char *'), /포인터/);
  assert.match(describeCType('const char *'), /const/);
  assert.match(describeCType('volatile uint32_t'), /volatile/);
  assert.match(describeCType('uint16_t[8]'), /8개 요소/);
});
