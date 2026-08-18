import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { CParser, ProjectIndex } from '../src/main/c-indexer.js';
import { parseMexInventory } from '../src/main/origin.js';
import type { ProjectFile } from '../src/shared/contracts.js';

const runtime = path.resolve('node_modules/web-tree-sitter/web-tree-sitter.wasm');
const grammar = path.resolve('node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-cpp.wasm');

test('C index resolves functions, callers, variables, typedef and union fields', async () => {
  const parser = new CParser(runtime, grammar);
  const mex = parseMexInventory([]);
  const headerFile: ProjectFile = { path: 'inc/model.h', kind: 'header', size: 100 };
  const sourceFile: ProjectFile = { path: 'src/main.c', kind: 'c', size: 200 };
  const header = await parser.parse(headerFile, `
    typedef union Payload { uint32_t raw; struct { uint16_t lo; uint16_t hi; } words; } Payload_t;
    int helper(int value);
  `, mex);
  const source = await parser.parse(sourceFile, `
    #include "model.h"
    static int counter = 0;
    int helper(int value) { return value + 1; }
    int main(void) { Payload_t p; p.raw = 3; counter = helper(p.raw); return counter; }
  `, mex);
  const index = new ProjectIndex(path.resolve('.'), [header, source]);
  const main = index.symbols.find((symbol) => symbol.name === 'main' && symbol.definition);
  const helper = index.symbols.find((symbol) => symbol.name === 'helper' && symbol.definition);
  const payload = index.symbols.find((symbol) => symbol.name === 'Payload' && symbol.kind === 'union');
  assert.ok(main);
  assert.ok(helper);
  assert.ok(main.calls.some((call) => call.name === 'helper' && call.resolved));
  assert.ok(helper.callers.some((call) => call.name === 'main'));
  assert.ok(index.symbols.some((symbol) => symbol.name === 'counter' && symbol.kind === 'variable'));
  assert.ok(index.symbols.some((symbol) => symbol.name === 'Payload_t' && symbol.kind === 'typedef'));
  assert.deepEqual(payload?.fields.map((field) => field.name), ['raw', 'words']);
  assert.ok(payload?.fields.find((field) => field.name === 'words')?.children.some((field) => field.name === 'lo'));
  const localPayload = index.symbols.find((symbol) => symbol.name === 'p' && symbol.kind === 'variable');
  assert.equal(localPayload?.resolvedType?.name, 'Payload_t');
  assert.deepEqual(localPayload?.resolvedType?.fields.map((field) => field.name), ['raw', 'words']);
  assert.ok(localPayload?.references.some((reference) => reference.kind === 'write'
    && reference.target === 'p.raw'
    && reference.changeDescription?.includes('p.raw')));

  const graph = index.graph({ rootId: main.id });
  assert.ok(graph.nodes.some((node) => node.name === 'main'));
  assert.ok(graph.nodes.some((node) => node.name === 'helper'));
  assert.ok(graph.edges.some((edge) => edge.from === main.id && edge.to === helper.id));

  const firstCounterReferences = index.symbols.find((symbol) => symbol.name === 'counter')?.references.length;
  const reopened = new ProjectIndex(path.resolve('.'), [header, source]);
  const reopenedCounter = reopened.symbols.find((symbol) => symbol.name === 'counter');
  assert.equal(reopenedCounter?.references.length, firstCounterReferences, '캐시 재사용 시 참조가 중복 누적되면 안 됨');
  const writes = reopenedCounter?.references.filter((reference) => reference.kind === 'write') ?? [];
  assert.equal(writes.length, 2, '초기값과 이후 대입을 모두 값 변경으로 표시해야 함');
  assert.ok(writes.some((reference) => reference.changeDescription?.includes('고정 값 0')));
  assert.ok(writes.some((reference) => reference.changeDescription?.includes('반환값')));
});

test('call graph ignores same-named variables and limits huge projects to meaningful roots', async () => {
  const parser = new CParser(runtime, grammar);
  const mex = parseMexInventory([]);
  const declarations = Array.from({ length: 40 }, (_, index) => `void Worker_${index}(void) {}`).join('\n');
  const file: ProjectFile = { path: 'src/large.c', kind: 'c', size: declarations.length + 100 };
  const parsed = await parser.parse(file, `
    int Conflicted = 0;
    void Caller(void) { Conflicted(); }
    ${declarations}
  `, mex);
  const index = new ProjectIndex(path.resolve('.'), [parsed]);
  const graph = index.graph({ limit: 100 });
  assert.ok(graph.roots.length <= 12);
  assert.ok(graph.nodes.length <= 13, '대표 진입점과 미해결 외부 호출만 표시해야 함');
  assert.doesNotThrow(() => index.graph({ rootId: index.symbols.find((symbol) => symbol.name === 'Caller')?.id }));
  const caller = index.symbols.find((symbol) => symbol.name === 'Caller');
  assert.equal(caller?.calls.find((call) => call.name === 'Conflicted')?.resolved, false);
});

test('generated source is surfaced as MEX evidence, never guessed as AI', async () => {
  const parser = new CParser(runtime, grammar);
  const mex = parseMexInventory([{ path: 'config.mex', source: '<instance name="Spi_Ip" />' }]);
  const file: ProjectFile = { path: 'generate/Spi_Ip_PBcfg.c', kind: 'c', size: 80 };
  const parsed = await parser.parse(file, '/* Auto-generated. Do not edit. */\nvoid Spi_Ip_Init(void) {}', mex);
  assert.equal(parsed.symbols.find((symbol) => symbol.name === 'Spi_Ip_Init')?.origin.kind, 'mex');
});

test('every src token can resolve external types/functions and function contracts', async () => {
  const parser = new CParser(runtime, grammar);
  const mex = parseMexInventory([]);
  const file: ProjectFile = { path: 'src/contracts.c', kind: 'c', size: 200 };
  const parsed = await parser.parse(file, `
    #define RETRY_LIMIT 3U
    status_t SendFrame(uint8_t port, const char *label) {
      return SDK_Send(port, label);
    }
  `, mex);
  const index = new ProjectIndex(path.resolve('.'), [parsed]);
  const fn = index.symbols.find((symbol) => symbol.name === 'SendFrame' && symbol.definition);
  assert.deepEqual(fn?.parameters.map((parameter) => [parameter.type, parameter.name]), [['uint8_t', 'port'], ['const char *', 'label']]);
  assert.deepEqual(fn?.returnExpressions, ['SDK_Send(port, label)']);

  const statusType = index.getSymbolAt('src/contracts.c', 3, 5, 'status_t');
  assert.equal(statusType?.synthetic, 'external-type');
  assert.equal(statusType?.kind, 'typedef');
  const sdkCall = index.getSymbolAt('src/contracts.c', 4, 14, 'SDK_Send');
  assert.equal(sdkCall?.synthetic, 'external-symbol');
  assert.equal(sdkCall?.kind, 'function');
  assert.equal(sdkCall?.type, 'status_t', '호출 결과가 그대로 반환되면 외부 함수 반환형을 호출 함수에서 추론해야 함');
  assert.deepEqual(fn?.calls.find((call) => call.name === 'SDK_Send')?.arguments, ['port', 'label']);
  assert.deepEqual(sdkCall?.callers[0]?.arguments, ['port', 'label']);
  assert.equal(index.getSymbolAt('src/contracts.c', 2, 13, 'RETRY_LIMIT')?.kind, 'macro');
});

test('macro values and their resolved assignment values remain visible', async () => {
  const parser = new CParser(runtime, grammar);
  const mex = parseMexInventory([]);
  const source = `#define BASE_PORT 500U
#define ACTIVE_PORT BASE_PORT
#define NEXT_PORT (ACTIVE_PORT + 1U)
static uint16_t port = ACTIVE_PORT;
void Configure(void) {
  port = NEXT_PORT;
}
`;
  const file: ProjectFile = { path: 'src/macros.c', kind: 'c', size: source.length };
  const parsed = await parser.parse(file, source, mex);
  const index = new ProjectIndex(path.resolve('.'), [parsed]);

  const base = index.symbols.find((symbol) => symbol.name === 'BASE_PORT' && symbol.kind === 'macro');
  const active = index.symbols.find((symbol) => symbol.name === 'ACTIVE_PORT' && symbol.kind === 'macro');
  const next = index.symbols.find((symbol) => symbol.name === 'NEXT_PORT' && symbol.kind === 'macro');
  assert.equal(base?.macro?.replacement, '500U');
  assert.equal(base?.macro?.expandedReplacement, '500U');
  assert.equal(active?.macro?.replacement, 'BASE_PORT');
  assert.equal(active?.macro?.expandedReplacement, '500U');
  assert.equal(next?.macro?.expandedReplacement, '(500U + 1U)');
  assert.equal(next?.macro?.calculatedValue, '501 (10진수)');
  assert.match(active?.signature ?? '', /^#define ACTIVE_PORT BASE_PORT/);

  const port = index.symbols.find((symbol) => symbol.name === 'port' && symbol.kind === 'variable');
  const writes = port?.references.filter((reference) => reference.kind === 'write') ?? [];
  assert.ok(writes.some((reference) => reference.valueExpression === 'ACTIVE_PORT' && reference.expandedValue === '500U'));
  assert.ok(writes.some((reference) => reference.valueExpression === 'NEXT_PORT'
    && reference.expandedValue === '(500U + 1U)'
    && reference.calculatedValue === '501 (10진수)'));
});

test('typedef enum exposes explicit and implicit member values', async () => {
  const parser = new CParser(runtime, grammar);
  const mex = parseMexInventory([]);
  const file: ProjectFile = { path: 'src/state.c', kind: 'c', size: 220 };
  const parsed = await parser.parse(file, `
    #define STAGE_BASE (1U << 2)
    typedef enum {
      STAGE_IDLE = 0U,
      STAGE_READY = STAGE_BASE,
      STAGE_RUNNING,
      STAGE_FAILED = 0x10U
    } stage_t;
  `, mex);
  const index = new ProjectIndex(path.resolve('.'), [parsed]);
  const type = index.symbols.find((symbol) => symbol.name === 'stage_t' && symbol.kind === 'typedef');
  assert.deepEqual(type?.fields.map((field) => field.name), ['STAGE_IDLE', 'STAGE_READY', 'STAGE_RUNNING', 'STAGE_FAILED']);
  assert.equal(type?.fields[0]?.calculatedValue, '0 (10진수)');
  assert.match(type?.fields[1]?.calculatedValue ?? '', /0b100.*4.*0x4/);
  assert.equal(type?.fields[2]?.calculatedValue, '5 (10진수)');
  assert.match(type?.fields[3]?.calculatedValue ?? '', /0x10.*16/);
});

test('C language qualifiers never become unresolved external variables', async () => {
  const parser = new CParser(runtime, grammar);
  const mex = parseMexInventory([]);
  const file: ProjectFile = { path: 'src/qualifiers.c', kind: 'c', size: 160 };
  const parsed = await parser.parse(file, `
    static volatile uint32_t status;
    void Send(const uint8_t * restrict payload) { status = payload[0]; }
  `, mex);
  const index = new ProjectIndex(path.resolve('.'), [parsed]);
  for (const word of ['static', 'volatile', 'const', 'restrict']) {
    assert.equal(index.symbols.some((symbol) => symbol.name === word), false, `${word} must remain C syntax`);
  }
  assert.equal(index.getSymbolAt('src/qualifiers.c', 3, 15, 'const'), null);
});

test('member fields are recovered from use sites when an SDK type definition is external', async () => {
  const parser = new CParser(runtime, grammar);
  const mex = parseMexInventory([]);
  const file: ProjectFile = { path: 'src/external-control.c', kind: 'c', size: 220 };
  const parsed = await parser.parse(file, `
    void Configure(void) {
      SWITCH_SJA11XX_Control_t control;
      status_t status;
      control.valid = true;
      control.rdwrset = false;
      control.index = 2U;
      memset(&control, 0, sizeof(control));
      status = SWITCH_SJA1110_setControl(&control, swt);
    }
  `, mex);
  const index = new ProjectIndex(path.resolve('.'), [parsed]);
  const control = index.symbols.find((symbol) => symbol.name === 'control' && symbol.kind === 'variable');
  assert.equal(control?.resolvedType?.name, 'SWITCH_SJA11XX_Control_t');
  assert.equal(control?.resolvedType?.inferred, true);
  assert.deepEqual(control?.resolvedType?.fields.map((field) => field.name), ['valid', 'rdwrset', 'index']);
  assert.ok(control?.resolvedType?.fields.every((field) => field.inferred));
  assert.ok(control?.references.some((reference) => reference.target === 'control.valid'
    && reference.changeDescription?.includes('고정 값 true')));

  const memset = index.symbols.find((symbol) => symbol.name === 'memset' && symbol.kind === 'function');
  assert.equal(memset?.type, 'void *');
  assert.equal(memset?.origin.label, 'C 표준 라이브러리');
  assert.deepEqual(memset?.parameters.map((parameter) => parameter.name), ['destination', 'value', 'count']);

  const setControl = index.symbols.find((symbol) => symbol.name === 'SWITCH_SJA1110_setControl' && symbol.kind === 'function');
  assert.equal(setControl?.type, 'status_t');
  assert.deepEqual(setControl?.callers[0]?.arguments, ['&control', 'swt']);
});
