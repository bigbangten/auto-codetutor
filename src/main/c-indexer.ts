import { createHash } from 'node:crypto';
import path from 'node:path';
import { Language, Parser, type Node as SyntaxNode } from 'web-tree-sitter';
import type {
  CallGraph,
  CallInfo,
  FieldInfo,
  FunctionParameterInfo,
  GraphEdge,
  GraphNode,
  OriginEvidence,
  ProjectFile,
  ProjectSnapshot,
  ReferenceInfo,
  SourceRange,
  SymbolKind,
  SymbolRecord,
  SymbolSummary,
} from '../shared/contracts.js';
import { isCReservedWord } from '../shared/c-glossary.js';
import { classifyOrigin, type MexInventory } from './origin.js';

interface RawOccurrence {
  name: string;
  kind: ReferenceInfo['kind'];
  range: SourceRange;
  isType?: boolean;
  container?: string;
  target?: string;
  expression?: string;
  changeDescription?: string;
  valueSource?: ReferenceInfo['valueSource'];
}

interface RawCall {
  callerId: string;
  name: string;
  range: SourceRange;
  arguments: string[];
  /** Variable receiving the return value, or $return when forwarded by return. */
  resultTarget?: string;
}

interface RawMemberAccess {
  owner: string;
  path: string[];
  range: SourceRange;
  container?: string;
}

export interface ParsedFile {
  file: ProjectFile;
  hash: string;
  symbols: SymbolRecord[];
  occurrences: RawOccurrence[];
  calls: RawCall[];
  memberAccesses: RawMemberAccess[];
  parseErrors: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableId(file: string, kind: SymbolKind, scope: string, name: string, line: number): string {
  return digest(`${file}\0${kind}\0${scope}\0${name}\0${line}`).slice(0, 24);
}

function rangeOf(file: string, node: SyntaxNode): SourceRange {
  return {
    file,
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: Math.max(1, node.endPosition.column + 1),
  };
}

function contains(range: SourceRange, line: number, column = 1): boolean {
  if (line < range.startLine || line > range.endLine) return false;
  if (line === range.startLine && column < range.startColumn) return false;
  if (line === range.endLine && column > range.endColumn) return false;
  return true;
}

function descendants(node: SyntaxNode, types: string | string[]): SyntaxNode[] {
  return node.descendantsOfType(types);
}

function declaratorIdentifier(node: SyntaxNode | null): SyntaxNode | null {
  if (!node) return null;
  if (node.type === 'identifier' || node.type === 'field_identifier' || node.type === 'type_identifier') return node;
  const explicit = node.childForFieldName('declarator');
  if (explicit) return declaratorIdentifier(explicit);
  for (const child of node.namedChildren) {
    const found = declaratorIdentifier(child);
    if (found) return found;
  }
  return null;
}

function pointerDepth(node: SyntaxNode | null): number {
  let depth = 0;
  let current = node;
  while (current) {
    if (current.type === 'pointer_declarator' || current.type === 'abstract_pointer_declarator') depth += 1;
    current = current.childForFieldName('declarator');
  }
  return depth;
}

function declaredType(declaration: SyntaxNode, declarator: SyntaxNode | null): string {
  const typeNode = declaration.childForFieldName('type')
    ?? declaration.namedChildren.find((child) => ['primitive_type', 'type_identifier', 'sized_type_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier'].includes(child.type));
  const qualifiers = declaration.namedChildren
    .filter((child) => child.type === 'type_qualifier')
    .map((child) => child.text.trim())
    .filter(Boolean);
  const aggregateKind = typeNode?.type.match(/^(struct|union|enum)_specifier$/)?.[1];
  const aggregateName = typeNode?.childForFieldName('name')?.text;
  const base = aggregateKind
    ? `${aggregateKind}${aggregateName ? ` ${aggregateName}` : ' (anonymous)'}`
    : typeNode?.text.replace(/\s+/g, ' ').trim() || '타입 확인 필요';
  const stars = pointerDepth(declarator);
  const array = declarator?.descendantsOfType('array_declarator')[0]?.text.match(/\[[^\]]*\]/)?.[0] ?? '';
  return `${qualifiers.length ? `${qualifiers.join(' ')} ` : ''}${base}${stars ? ` ${'*'.repeat(stars)}` : ''}${array}`.trim();
}

function concise(value: string, max = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function valueDescription(right: SyntaxNode, operator = '='): Pick<RawOccurrence, 'changeDescription' | 'valueSource'> {
  const value = concise(right.text);
  if (operator === '++' || operator === '+=') return { changeDescription: operator === '++' ? '현재 값에서 1 증가' : `${value}만큼 증가`, valueSource: 'increment' };
  if (operator === '--' || operator === '-=') return { changeDescription: operator === '--' ? '현재 값에서 1 감소' : `${value}만큼 감소`, valueSource: 'decrement' };
  if (/^(?:[-+]?\d+(?:\.\d+)?(?:[uUlLfF]+)?|0x[\da-f]+(?:[uUlL]+)?|true|false|NULL|nullptr|'(?:\\.|[^'])+'|"(?:\\.|[^"])*")$/i.test(value)) {
    return { changeDescription: `고정 값 ${value} 대입`, valueSource: 'constant' };
  }
  if (right.type === 'call_expression' || right.descendantsOfType('call_expression').length === 1 && right.namedChildCount === 1) {
    const call = right.type === 'call_expression' ? right : right.descendantsOfType('call_expression')[0]!;
    const name = call.childForFieldName('function')?.text ?? '함수';
    return { changeDescription: `${concise(name)}() 반환값 대입`, valueSource: 'call' };
  }
  if (['identifier', 'field_expression', 'subscript_expression', 'pointer_expression'].includes(right.type)) {
    return { changeDescription: `${value}의 현재 값 복사`, valueSource: 'variable' };
  }
  return { changeDescription: `${value} 식의 계산 결과 대입`, valueSource: 'expression' };
}

function occurrenceKind(node: SyntaxNode): Pick<RawOccurrence, 'kind' | 'target' | 'expression' | 'changeDescription' | 'valueSource'> {
  let current: SyntaxNode | null = node;
  for (let depth = 0; current?.parent && depth < 6; depth += 1) {
    const parent: SyntaxNode = current.parent;
    if (parent.type === 'update_expression') {
      const operator = parent.text.includes('++') ? '++' : '--';
      const target = concise(parent.namedChildren[0]?.text ?? node.text);
      const change = valueDescription(parent, operator);
      return { kind: 'write', target, expression: concise(parent.text), ...change, changeDescription: `${target}: ${change.changeDescription}` };
    }
    if (parent.type === 'assignment_expression') {
      const left = parent.childForFieldName('left');
      const right = parent.childForFieldName('right');
      if (left && node.startIndex >= left.startIndex && node.endIndex <= left.endIndex) {
        const operator = right ? parent.text.slice(left.endIndex - parent.startIndex, right.startIndex - parent.startIndex).trim() || '=' : '=';
        const target = concise(left.text);
        const change = right ? valueDescription(right, operator) : { changeDescription: '값 변경', valueSource: 'expression' as const };
        return {
          kind: 'write',
          target,
          expression: concise(parent.text),
          ...change,
          changeDescription: `${target}: ${change.changeDescription}`,
        };
      }
      return { kind: 'read' };
    }
    if (parent.type === 'call_expression' && parent.childForFieldName('function')?.id === node.id) return { kind: 'call' };
    current = parent;
  }
  return { kind: 'read' };
}

function initializerOccurrence(file: string, name: string, declarator: SyntaxNode, container?: string): RawOccurrence | null {
  const init = declarator.parent?.type === 'init_declarator' ? declarator.parent : null;
  if (!init) return null;
  const value = init.childForFieldName('value')
    ?? init.namedChildren.find((child) => child.id !== declarator.id && child.startIndex >= declarator.endIndex);
  if (!value) return null;
  const nameNode = declaratorIdentifier(declarator);
  if (!nameNode) return null;
  const description = valueDescription(value);
  return {
    name,
    kind: 'write',
    range: rangeOf(file, nameNode),
    container,
    target: name,
    expression: concise(`${name} = ${value.text}`),
    ...description,
    changeDescription: `${name}: ${description.changeDescription}`,
    valueSource: description.valueSource === 'expression' ? 'initializer' : description.valueSource,
  };
}

function callResultTarget(call: SyntaxNode): string | undefined {
  let current: SyntaxNode | null = call;
  for (let depth = 0; current?.parent && depth < 6; depth += 1) {
    const parent: SyntaxNode = current.parent;
    if (parent.type === 'assignment_expression') {
      const right = parent.childForFieldName('right');
      const left = parent.childForFieldName('left');
      return right && left && call.startIndex >= right.startIndex && call.endIndex <= right.endIndex
        ? concise(left.text)
        : undefined;
    }
    if (parent.type === 'init_declarator') {
      const value = parent.childForFieldName('value');
      const declarator = parent.childForFieldName('declarator');
      const name = declaratorIdentifier(declarator);
      return value && name && call.startIndex >= value.startIndex && call.endIndex <= value.endIndex ? name.text : undefined;
    }
    if (parent.type === 'return_statement') return '$return';
    if (['argument_list', 'expression_statement', 'compound_statement'].includes(parent.type)) return undefined;
    current = parent;
  }
  return undefined;
}

function directDeclarators(declaration: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (const child of declaration.namedChildren) {
    if (child.type === 'init_declarator') {
      const declarator = child.childForFieldName('declarator');
      if (declarator) result.push(declarator);
    } else if (child.type.includes('declarator') || child.type === 'identifier' || child.type === 'field_identifier') {
      result.push(child);
    }
  }
  return result;
}

function fieldChildren(file: string, specifier: SyntaxNode): FieldInfo[] {
  const body = specifier.childForFieldName('body')
    ?? specifier.namedChildren.find((child) => child.type === 'field_declaration_list');
  if (!body) return [];
  const fields: FieldInfo[] = [];
  for (const declaration of body.namedChildren.filter((child) => child.type === 'field_declaration')) {
    const typeNode = declaration.childForFieldName('type');
    const nested = typeNode && ['struct_specifier', 'union_specifier'].includes(typeNode.type) ? fieldChildren(file, typeNode) : [];
    const declarators = directDeclarators(declaration);
    if (declarators.length === 0 && nested.length > 0) {
      fields.push({ name: '(익명)', type: typeNode?.type.replace('_specifier', '') ?? 'anonymous', range: rangeOf(file, declaration), children: nested });
      continue;
    }
    for (const declarator of declarators) {
      const nameNode = declaratorIdentifier(declarator);
      if (!nameNode) continue;
      fields.push({
        name: nameNode.text,
        type: declaredType(declaration, declarator),
        range: rangeOf(file, nameNode),
        children: nested,
      });
    }
  }
  return fields;
}

function isDefinitionNode(node: SyntaxNode, definitions: Set<string>): boolean {
  return definitions.has(`${node.startIndex}:${node.endIndex}`);
}

function enclosingFunction(functions: SymbolRecord[], node: SyntaxNode): SymbolRecord | undefined {
  return functions.find((fn) => fn.definition && contains(fn.definition, node.startPosition.row + 1, node.startPosition.column + 1));
}

function memberAccessOf(file: string, node: SyntaxNode, container?: string): RawMemberAccess | null {
  if (node.type !== 'field_expression') return null;
  const field = node.childForFieldName('field');
  const argument = node.childForFieldName('argument');
  if (!field || !argument) return null;
  if (argument.type === 'identifier') {
    return { owner: argument.text, path: [field.text], range: rangeOf(file, field), container };
  }
  const parent = memberAccessOf(file, argument, container);
  return parent ? { ...parent, path: [...parent.path, field.text], range: rangeOf(file, field) } : null;
}

function mergeInferredField(fields: FieldInfo[], access: RawMemberAccess, depth = 0): void {
  const name = access.path[depth];
  if (!name) return;
  let field = fields.find((candidate) => candidate.name === name);
  if (!field) {
    field = {
      name,
      type: '타입 정의 확인 필요',
      range: access.range,
      children: [],
      inferred: true,
    };
    fields.push(field);
  }
  if (depth + 1 < access.path.length) mergeInferredField(field.children, access, depth + 1);
}

export class CParser {
  private parser: Parser | null = null;

  constructor(private readonly runtimeWasm: string, private readonly grammarWasm: string) {}

  async initialize(): Promise<void> {
    if (this.parser) return;
    await Parser.init({ locateFile: () => this.runtimeWasm });
    const language = await Language.load(this.grammarWasm);
    this.parser = new Parser();
    this.parser.setLanguage(language);
  }

  async parse(
    file: ProjectFile,
    source: string,
    mex: MexInventory,
    aiConfirmedFiles: Set<string> = new Set(),
  ): Promise<ParsedFile> {
    await this.initialize();
    const tree = this.parser!.parse(source);
    if (!tree) throw new Error(`${file.path} 구문 트리를 만들지 못했습니다.`);
    const root = tree.rootNode;
    const hash = digest(source);
    const origin = classifyOrigin(file.path, source, mex, aiConfirmedFiles);
    const symbols: SymbolRecord[] = [];
    const functions: SymbolRecord[] = [];
    const calls: RawCall[] = [];
    const occurrences: RawOccurrence[] = [];
    const memberAccesses: RawMemberAccess[] = [];
    const definitions = new Set<string>();
    const processedTypes = new Set<number>();

    const addSymbol = (input: {
      nameNode: SyntaxNode;
      kind: SymbolKind;
      type: string;
      scope: string;
      declaration?: SourceRange;
      definition?: SourceRange;
      signature?: string;
      fields?: FieldInfo[];
      parentId?: string;
      limitations?: string[];
    }): SymbolRecord => {
      const declaration = input.declaration ?? rangeOf(file.path, input.nameNode);
      const symbol: SymbolRecord = {
        id: stableId(file.path, input.kind, input.scope, input.nameNode.text, declaration.startLine),
        name: input.nameNode.text,
        kind: input.kind,
        type: input.type,
        signature: input.signature,
        scope: input.scope,
        parentId: input.parentId,
        declaration,
        definition: input.definition,
        parameters: [],
        returnExpressions: [],
        fields: input.fields ?? [],
        origin,
        references: [{ kind: input.definition ? 'definition' : 'declaration', range: input.definition ?? declaration, container: input.scope || undefined }],
        calls: [],
        callers: [],
        sourceHash: hash,
        limitations: input.limitations ?? [],
      };
      symbols.push(symbol);
      definitions.add(`${input.nameNode.startIndex}:${input.nameNode.endIndex}`);
      return symbol;
    };

    // Functions and their parameters/local variables are indexed first so every occurrence can
    // be assigned a lexical container in a second pass.
    for (const node of descendants(root, 'function_definition')) {
      const declarator = node.childForFieldName('declarator');
      const nameNode = declaratorIdentifier(declarator);
      const body = node.childForFieldName('body');
      if (!nameNode || !body) continue;
      const typeNode = node.childForFieldName('type');
      const fn = addSymbol({
        nameNode,
        kind: 'function',
        type: typeNode?.text.trim() || '반환 타입 확인 필요',
        scope: 'global',
        declaration: rangeOf(file.path, nameNode),
        definition: rangeOf(file.path, node),
        signature: source.slice(node.startIndex, body.startIndex).replace(/\s+/g, ' ').trim(),
        limitations: ['함수 포인터와 매크로를 통한 간접 호출은 호출 그래프에서 누락될 수 있습니다.'],
      });
      functions.push(fn);

      const parameterList = declarator?.descendantsOfType('parameter_list')[0];
      for (const parameter of parameterList?.namedChildren.filter((child) => child.type === 'parameter_declaration') ?? []) {
        const parameterDeclarator = parameter.childForFieldName('declarator');
        const parameterName = declaratorIdentifier(parameterDeclarator);
        if (!parameterName) continue;
        const parameterSymbol = addSymbol({
          nameNode: parameterName,
          kind: 'parameter',
          type: declaredType(parameter, parameterDeclarator),
          scope: fn.name,
          parentId: fn.id,
        });
        fn.parameters.push({ name: parameterSymbol.name, type: parameterSymbol.type, range: parameterSymbol.declaration });
      }
      fn.returnExpressions = body.descendantsOfType('return_statement')
        .map((statement) => statement.namedChildren[0]?.text.trim() ?? '')
        .filter(Boolean)
        .slice(0, 20);

      for (const declaration of body.descendantsOfType('declaration')) {
        if (declaration.parent?.type === 'field_declaration_list') continue;
        for (const localDeclarator of directDeclarators(declaration)) {
          if (localDeclarator.type === 'function_declarator') continue;
          const localName = declaratorIdentifier(localDeclarator);
          if (!localName) continue;
          addSymbol({
            nameNode: localName,
            kind: 'variable',
            type: declaredType(declaration, localDeclarator),
            scope: fn.name,
            parentId: fn.id,
          });
          const initialized = initializerOccurrence(file.path, localName.text, localDeclarator, fn.name);
          if (initialized) occurrences.push(initialized);
        }
      }

      for (const call of body.descendantsOfType('call_expression')) {
        const functionNode = call.childForFieldName('function');
        if (!functionNode) continue;
        const callee = functionNode.type === 'identifier'
          ? functionNode
          : functionNode.type === 'field_expression'
            ? functionNode.childForFieldName('field')
            : declaratorIdentifier(functionNode);
        if (!callee) continue;
        const argumentList = call.childForFieldName('arguments') ?? call.namedChildren.find((child) => child.type === 'argument_list');
        calls.push({
          callerId: fn.id,
          name: callee.text,
          range: rangeOf(file.path, callee),
          arguments: (argumentList?.namedChildren ?? []).map((argument) => concise(argument.text, 240)),
          resultTarget: callResultTarget(call),
        });
      }
    }

    // Named aggregate types, their fields, typedef aliases, and enums.
    for (const node of descendants(root, ['struct_specifier', 'union_specifier', 'enum_specifier'])) {
      if (processedTypes.has(node.id)) continue;
      processedTypes.add(node.id);
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      const kind = node.type.replace('_specifier', '') as 'struct' | 'union' | 'enum';
      const fields = kind === 'enum'
        ? (node.childForFieldName('body')?.namedChildren ?? []).map((child) => ({ name: child.childForFieldName('name')?.text ?? child.text, type: 'enum 값', range: rangeOf(file.path, child), children: [] }))
        : fieldChildren(file.path, node);
      const typeSymbol = addSymbol({
        nameNode,
        kind,
        type: kind,
        scope: 'global',
        definition: rangeOf(file.path, node),
        fields,
      });
      for (const field of fields) {
        const syntheticNode = node.descendantsOfType('field_identifier').find((candidate) => candidate.text === field.name);
        if (syntheticNode) addSymbol({ nameNode: syntheticNode, kind: 'field', type: field.type, scope: typeSymbol.name, parentId: typeSymbol.id });
      }
    }

    for (const node of descendants(root, 'type_definition')) {
      const aliasNode = node.childForFieldName('declarator') ?? node.namedChildren.find((child) => child.type === 'type_identifier');
      const nameNode = declaratorIdentifier(aliasNode ?? null);
      if (!nameNode) continue;
      const typeNode = node.childForFieldName('type');
      const aggregateKind = typeNode?.type.match(/^(struct|union|enum)_specifier$/)?.[1];
      const aggregateName = typeNode?.childForFieldName('name')?.text;
      addSymbol({
        nameNode,
        kind: 'typedef',
        type: aggregateKind ? `${aggregateKind}${aggregateName ? ` ${aggregateName}` : ' (anonymous)'}` : typeNode?.text.replace(/\s+/g, ' ').trim() || 'typedef',
        scope: 'global',
        fields: typeNode && ['struct_specifier', 'union_specifier'].includes(typeNode.type) ? fieldChildren(file.path, typeNode) : [],
      });
    }

    // Top-level prototypes and global variables.
    for (const declaration of root.namedChildren.filter((child) => child.type === 'declaration')) {
      for (const declarator of directDeclarators(declaration)) {
        const nameNode = declaratorIdentifier(declarator);
        if (!nameNode) continue;
        if (declarator.type === 'function_declarator' || declarator.descendantsOfType('function_declarator').length > 0) {
          const fn = addSymbol({
            nameNode,
            kind: 'function',
            type: declaredType(declaration, declarator),
            scope: 'global',
            signature: declaration.text.replace(/\s+/g, ' ').trim(),
          });
          const parameterList = declarator.descendantsOfType('parameter_list')[0];
          for (const parameter of parameterList?.namedChildren.filter((child) => child.type === 'parameter_declaration') ?? []) {
            const parameterDeclarator = parameter.childForFieldName('declarator');
            const parameterName = declaratorIdentifier(parameterDeclarator);
            if (!parameterName) continue;
            fn.parameters.push({ name: parameterName.text, type: declaredType(parameter, parameterDeclarator), range: rangeOf(file.path, parameterName) });
          }
        } else {
          addSymbol({ nameNode, kind: 'variable', type: declaredType(declaration, declarator), scope: 'global' });
          const initialized = initializerOccurrence(file.path, nameNode.text, declarator, 'global');
          if (initialized) occurrences.push(initialized);
        }
      }
    }

    for (const node of descendants(root, ['preproc_def', 'preproc_function_def'])) {
      const nameNode = node.childForFieldName('name') ?? node.namedChildren.find((child) => child.type === 'identifier');
      if (nameNode) addSymbol({ nameNode, kind: 'macro', type: node.type === 'preproc_function_def' ? '함수형 매크로' : '매크로', scope: 'global', definition: rangeOf(file.path, node) });
    }

    for (const node of descendants(root, ['identifier', 'field_identifier'])) {
      if (isDefinitionNode(node, definitions)) continue;
      const container = enclosingFunction(functions, node)?.name;
      occurrences.push({ name: node.text, ...occurrenceKind(node), range: rangeOf(file.path, node), container });
    }
    for (const node of descendants(root, 'field_expression')) {
      const access = memberAccessOf(file.path, node, enclosingFunction(functions, node)?.name);
      if (access) memberAccesses.push(access);
    }
    for (const node of descendants(root, ['type_identifier', 'primitive_type'])) {
      if (isDefinitionNode(node, definitions)) continue;
      const container = enclosingFunction(functions, node)?.name;
      occurrences.push({ name: node.text, kind: 'read', range: rangeOf(file.path, node), container, isType: true });
    }

    const parseErrors = descendants(root, 'ERROR').length + (root.hasError ? 1 : 0);
    tree.delete();
    return { file, hash, symbols, occurrences, calls, memberAccesses, parseErrors };
  }
}

function chooseCandidate(candidates: SymbolRecord[], occurrence: RawOccurrence): SymbolRecord | undefined {
  return [...candidates].sort((a, b) => {
    const score = (symbol: SymbolRecord): number =>
      (symbol.declaration.file === occurrence.range.file ? 20 : 0)
      + (occurrence.container && symbol.scope === occurrence.container ? 40 : 0)
      + (symbol.kind === 'function' && occurrence.kind === 'call' ? 30 : 0)
      + (symbol.definition ? 5 : 0)
      - (symbol.kind === 'field' && occurrence.kind !== 'read' && occurrence.kind !== 'write' ? 5 : 0);
    return score(b) - score(a);
  })[0];
}

const AGGREGATE_KINDS = new Set<SymbolKind>(['typedef', 'struct', 'union', 'enum']);
const TYPE_NOISE = new Set([
  'const', 'volatile', 'static', 'extern', 'register', 'signed', 'unsigned', 'short', 'long',
  'struct', 'union', 'enum', 'void', 'char', 'int', 'float', 'double', 'bool', '_Bool', 'anonymous',
]);

const TYPE_QUALIFIERS = new Set([
  'const', 'volatile', 'static', 'extern', 'register', 'signed', 'unsigned', 'short', 'long',
  'struct', 'union', 'enum', 'anonymous',
]);

interface KnownCFunction {
  returnType: string;
  signature: string;
  parameters: Array<{ name: string; type: string }>;
}

const KNOWN_C_FUNCTIONS: Record<string, KnownCFunction> = {
  memset: { returnType: 'void *', signature: 'void *memset(void *destination, int value, size_t count)', parameters: [{ name: 'destination', type: 'void *' }, { name: 'value', type: 'int' }, { name: 'count', type: 'size_t' }] },
  memcpy: { returnType: 'void *', signature: 'void *memcpy(void *destination, const void *source, size_t count)', parameters: [{ name: 'destination', type: 'void *' }, { name: 'source', type: 'const void *' }, { name: 'count', type: 'size_t' }] },
  memmove: { returnType: 'void *', signature: 'void *memmove(void *destination, const void *source, size_t count)', parameters: [{ name: 'destination', type: 'void *' }, { name: 'source', type: 'const void *' }, { name: 'count', type: 'size_t' }] },
  memcmp: { returnType: 'int', signature: 'int memcmp(const void *left, const void *right, size_t count)', parameters: [{ name: 'left', type: 'const void *' }, { name: 'right', type: 'const void *' }, { name: 'count', type: 'size_t' }] },
  strlen: { returnType: 'size_t', signature: 'size_t strlen(const char *text)', parameters: [{ name: 'text', type: 'const char *' }] },
  strcmp: { returnType: 'int', signature: 'int strcmp(const char *left, const char *right)', parameters: [{ name: 'left', type: 'const char *' }, { name: 'right', type: 'const char *' }] },
  strncmp: { returnType: 'int', signature: 'int strncmp(const char *left, const char *right, size_t count)', parameters: [{ name: 'left', type: 'const char *' }, { name: 'right', type: 'const char *' }, { name: 'count', type: 'size_t' }] },
  malloc: { returnType: 'void *', signature: 'void *malloc(size_t size)', parameters: [{ name: 'size', type: 'size_t' }] },
  calloc: { returnType: 'void *', signature: 'void *calloc(size_t count, size_t size)', parameters: [{ name: 'count', type: 'size_t' }, { name: 'size', type: 'size_t' }] },
  realloc: { returnType: 'void *', signature: 'void *realloc(void *memory, size_t size)', parameters: [{ name: 'memory', type: 'void *' }, { name: 'size', type: 'size_t' }] },
  free: { returnType: 'void', signature: 'void free(void *memory)', parameters: [{ name: 'memory', type: 'void *' }] },
};

function typeNames(type: string): string[] {
  return (type.match(/[A-Za-z_]\w*/g) ?? []).filter((name) => !TYPE_NOISE.has(name));
}

function referencedTypeNames(type: string): string[] {
  return [...new Set((type.match(/[A-Za-z_]\w*/g) ?? []).filter((name) => !TYPE_QUALIFIERS.has(name)))];
}

function resolveTypeRecord(symbol: SymbolRecord, byName: Map<string, SymbolRecord[]>): SymbolRecord | null {
  const visited = new Set<string>();
  const queue = typeNames(symbol.type);
  while (queue.length) {
    const name = queue.shift()!;
    for (const candidate of byName.get(name) ?? []) {
      if (candidate.id === symbol.id || visited.has(candidate.id) || !AGGREGATE_KINDS.has(candidate.kind)) continue;
      visited.add(candidate.id);
      if (candidate.synthetic === 'external-type') return candidate;
      if (candidate.fields.length || candidate.kind !== 'typedef') return candidate;
      queue.unshift(...typeNames(candidate.type));
      if (candidate.fields.length) return candidate;
    }
  }
  return null;
}

export class ProjectIndex {
  readonly symbols: SymbolRecord[];
  readonly byId = new Map<string, SymbolRecord>();
  readonly byName = new Map<string, SymbolRecord[]>();
  private readonly filesByPath = new Map<string, ParsedFile>();

  constructor(readonly rootPath: string, readonly parsedFiles: ParsedFile[]) {
    // references/calls/callers are project-wide derived data. Cached ParsedFile objects may
    // already contain a previous construction's derived entries, so restore the parser's
    // single local definition/declaration reference before rebuilding cross-file relations.
    for (const file of parsedFiles) {
      for (const symbol of file.symbols) {
        symbol.resolvedType = undefined;
        symbol.references = [{
          kind: symbol.definition ? 'definition' : 'declaration',
          range: symbol.definition ?? symbol.declaration,
          container: symbol.scope || undefined,
        }];
        symbol.calls = [];
        symbol.callers = [];
      }
    }
    const prototypes: SymbolRecord[] = [];
    const concreteFunctions = new Map<string, SymbolRecord[]>();
    for (const file of parsedFiles) {
      this.filesByPath.set(file.file.path, file);
      for (const symbol of file.symbols) {
        if (symbol.kind === 'function' && symbol.definition) {
          const list = concreteFunctions.get(symbol.name) ?? [];
          list.push(symbol);
          concreteFunctions.set(symbol.name, list);
        }
      }
    }

    const kept: SymbolRecord[] = [];
    for (const file of parsedFiles) {
      for (const symbol of file.symbols) {
        if (symbol.kind === 'function' && !symbol.definition) {
          prototypes.push(symbol);
          continue;
        }
        kept.push(symbol);
      }
    }
    for (const prototype of prototypes) {
      const target = concreteFunctions.get(prototype.name)?.[0];
      if (target) target.references.push({ kind: 'declaration', range: prototype.declaration });
      else kept.push(prototype);
    }
    this.symbols = kept;

    const registerSymbol = (symbol: SymbolRecord): void => {
      this.symbols.push(symbol);
      this.byId.set(symbol.id, symbol);
      const names = this.byName.get(symbol.name) ?? [];
      names.push(symbol);
      this.byName.set(symbol.name, names);
    };

    for (const symbol of this.symbols) {
      this.byId.set(symbol.id, symbol);
      const names = this.byName.get(symbol.name) ?? [];
      names.push(symbol);
      this.byName.set(symbol.name, names);
    }

    // Types supplied by the compiler, libc, lwIP, or an SDK header outside the opened
    // project still need to be selectable. Keep a lightweight first-use record so a
    // click never leaves the previous symbol panel stale.
    const typeUses = new Map<string, SymbolRecord[]>();
    for (const owner of [...this.symbols]) {
      for (const name of referencedTypeNames(owner.type)) {
        const alreadyIndexed = (this.byName.get(name) ?? []).some((candidate) => AGGREGATE_KINDS.has(candidate.kind));
        if (alreadyIndexed) continue;
        const uses = typeUses.get(name) ?? [];
        uses.push(owner);
        typeUses.set(name, uses);
      }
    }
    for (const [name, owners] of typeUses) {
      const first = owners[0];
      if (!first) continue;
      const range = first.declaration;
      const anchors = [...new Map(owners.map((owner) => {
        const item = owner.declaration;
        return [`${item.file}:${item.startLine}:${item.startColumn}`, item] as const;
      })).values()].slice(0, 12);
      registerSymbol({
        id: stableId(range.file, 'typedef', 'external-type', name, range.startLine),
        name,
        kind: 'typedef',
        type: name,
        signature: name,
        scope: 'global',
        declaration: range,
        parameters: [],
        returnExpressions: [],
        fields: [],
        origin: {
          kind: 'unknown',
          label: '기본/외부 타입',
          confidence: 'limited',
          rule: '프로젝트 내부에서 타입 정의를 찾지 못해 코드의 사용 위치를 기준으로 표시합니다.',
          anchors,
        },
        references: anchors.map((item) => ({ kind: 'read', range: item })),
        calls: [],
        callers: [],
        sourceHash: first.sourceHash,
        limitations: ['정확한 비트 폭과 값 범위는 컴파일러 또는 SDK의 실제 typedef 정의에 따라 달라질 수 있습니다.'],
        synthetic: 'external-type',
      });
    }

    // Also surface identifiers whose declaration lives outside the opened folder. This
    // covers SDK functions, globals, and macros while preserving the "definition unresolved"
    // distinction used by the call graph.
    const unresolved = new Map<string, { kind: SymbolKind; occurrences: RawOccurrence[]; hash: string }>();
    for (const file of parsedFiles) {
      for (const occurrence of file.occurrences) {
        // Some declarator shapes expose qualifiers as named nodes. These tokens are
        // C grammar, never missing variables supplied by an external SDK.
        if (isCReservedWord(occurrence.name)) continue;
        const compatible = (this.byName.get(occurrence.name) ?? []).some((candidate) => occurrence.isType
          ? AGGREGATE_KINDS.has(candidate.kind)
          : occurrence.kind === 'call'
            ? candidate.kind === 'function' || candidate.kind === 'macro'
            : !AGGREGATE_KINDS.has(candidate.kind));
        if (compatible) continue;
        const kind: SymbolKind = occurrence.isType
          ? 'typedef'
          : occurrence.kind === 'call'
          ? 'function'
          : /^[A-Z][A-Z0-9_]*$/.test(occurrence.name) ? 'macro' : 'variable';
        if (kind === 'typedef') continue;
        const key = `${kind}\0${occurrence.name}`;
        const entry = unresolved.get(key) ?? { kind, occurrences: [], hash: file.hash };
        entry.occurrences.push(occurrence);
        unresolved.set(key, entry);
      }
    }
    for (const entry of unresolved.values()) {
      const first = entry.occurrences[0];
      if (!first) continue;
      const observedCalls = entry.kind === 'function'
        ? parsedFiles.flatMap((file) => file.calls.filter((call) => call.name === first.name))
        : [];
      const knownFunction = entry.kind === 'function' ? KNOWN_C_FUNCTIONS[first.name] : undefined;
      const inferredTypes = observedCalls.flatMap((call) => {
        if (!call.resultTarget) return [];
        if (call.resultTarget === '$return') {
          const caller = this.byId.get(call.callerId);
          return caller && !/확인 필요/.test(caller.type) ? [caller.type] : [];
        }
        const rootName = call.resultTarget.match(/[A-Za-z_]\w*/)?.[0];
        if (!rootName) return [];
        const caller = this.byId.get(call.callerId);
        const candidate = chooseCandidate(
          (this.byName.get(rootName) ?? []).filter((symbol) => ['variable', 'parameter', 'field'].includes(symbol.kind)),
          { name: rootName, kind: 'write', range: call.range, container: caller?.name },
        );
        return candidate && !/확인 필요/.test(candidate.type) ? [candidate.type] : [];
      });
      const inferredType = inferredTypes.sort((left, right) =>
        inferredTypes.filter((value) => value === right).length - inferredTypes.filter((value) => value === left).length,
      )[0];
      const functionType = knownFunction?.returnType ?? inferredType ?? '반환 타입 확인 필요';
      const observedArity = observedCalls.reduce((maximum, call) => Math.max(maximum, call.arguments.length), 0);
      const parameters: FunctionParameterInfo[] = (knownFunction?.parameters ?? []).map((parameter) => ({
        ...parameter,
        range: first.range,
      }));
      const originLabel = knownFunction ? 'C 표준 라이브러리' : '외부/정의 미해결';
      const originRule = knownFunction
        ? 'ISO C 표준 라이브러리에서 정한 함수 시그니처를 사용하고, 현재 프로젝트의 호출 위치를 함께 표시합니다.'
        : '열린 프로젝트에서 선언 또는 정의를 찾지 못했지만 코드 사용 위치는 확인했습니다.';
      registerSymbol({
        id: stableId(first.range.file, entry.kind, 'external-symbol', first.name, first.range.startLine),
        name: first.name,
        kind: entry.kind,
        type: entry.kind === 'function' ? functionType : entry.kind === 'macro' ? '외부 매크로' : '외부 선언 타입 확인 필요',
        signature: entry.kind === 'function' ? knownFunction?.signature ?? `${functionType} ${first.name}(${observedArity ? `호출부 인자 ${observedArity}개 · 선언 미확인` : '...'})` : undefined,
        scope: 'external',
        declaration: first.range,
        parameters,
        returnExpressions: [],
        fields: [],
        origin: {
          kind: 'unknown',
          label: originLabel,
          confidence: 'limited',
          rule: originRule,
          anchors: entry.occurrences.slice(0, 12).map((occurrence) => occurrence.range),
        },
        references: [{ kind: 'declaration', range: first.range, container: first.container }],
        calls: [],
        callers: [],
        sourceHash: digest(`${entry.hash}\0${functionType}\0${observedArity}\0${knownFunction?.signature ?? ''}`),
        limitations: knownFunction
          ? ['플랫폼별 확장 동작과 실제 선언 헤더는 사용 중인 C 라이브러리 구현을 함께 확인해야 합니다.']
          : ['선언이 포함된 SDK 또는 외부 헤더가 프로젝트 범위에 없어 정확한 매개변수 타입은 확정할 수 없습니다. 호출부에서 관찰한 인자와 결과 저장 위치를 대신 표시합니다.'],
        synthetic: 'external-symbol',
      });
    }

    for (const symbol of this.symbols) {
      if (!['variable', 'parameter', 'field'].includes(symbol.kind)) continue;
      const resolved = resolveTypeRecord(symbol, this.byName);
      if (!resolved || !AGGREGATE_KINDS.has(resolved.kind)) continue;
      symbol.resolvedType = {
        symbolId: resolved.id,
        name: resolved.name,
        kind: resolved.kind as 'typedef' | 'struct' | 'union' | 'enum',
        range: resolved.definition ?? resolved.declaration,
        fields: resolved.fields,
        inferred: resolved.synthetic === 'external-type',
      };
    }

    // SDK/compiler headers are often linked through the build system and are not
    // physically inside the selected project. Recover the visible member shape
    // from expressions such as control.valid and control.index so the variable
    // remains useful even when the typedef declaration cannot be indexed.
    for (const file of parsedFiles) {
      for (const access of file.memberAccesses ?? []) {
        const candidates = (this.byName.get(access.owner) ?? []).filter((candidate) => ['variable', 'parameter', 'field'].includes(candidate.kind));
        const owner = chooseCandidate(candidates, {
          name: access.owner,
          kind: 'read',
          range: access.range,
          container: access.container,
        });
        if (!owner) continue;
        if (owner.resolvedType) {
          const type = this.byId.get(owner.resolvedType.symbolId);
          const fields = type?.fields ?? owner.resolvedType.fields;
          mergeInferredField(fields, access);
          owner.resolvedType.fields = fields;
        } else {
          mergeInferredField(owner.fields, access);
        }
      }
    }
    for (const file of parsedFiles) {
      for (const occurrence of file.occurrences) {
        const allCandidates = this.byName.get(occurrence.name) ?? [];
        const compatible = occurrence.isType
          ? allCandidates.filter((candidate) => AGGREGATE_KINDS.has(candidate.kind))
          : occurrence.kind === 'call'
            ? allCandidates.filter((candidate) => candidate.kind === 'function' || candidate.kind === 'macro')
            : allCandidates.filter((candidate) => !AGGREGATE_KINDS.has(candidate.kind));
        const target = chooseCandidate(compatible.length ? compatible : allCandidates, occurrence);
        if (target) target.references.push({
          kind: occurrence.kind,
          range: occurrence.range,
          container: occurrence.container,
          target: occurrence.target,
          expression: occurrence.expression,
          changeDescription: occurrence.changeDescription,
          valueSource: occurrence.valueSource,
        });
      }
      for (const call of file.calls) {
        const caller = this.byId.get(call.callerId);
        if (!caller) continue;
        const target = chooseCandidate(
          (this.byName.get(call.name) ?? []).filter((candidate) => candidate.kind === 'function'),
          { name: call.name, kind: 'call', range: call.range, container: caller.name },
        );
        const callInfo: CallInfo = {
          name: call.name,
          range: call.range,
          symbolId: target?.id,
          resolved: Boolean(target?.definition),
          arguments: call.arguments,
        };
        caller.calls.push(callInfo);
        if (target) target.callers.push({ name: caller.name, range: call.range, symbolId: caller.id, resolved: true, arguments: call.arguments });
      }
    }
  }

  getSymbol(id: string): SymbolRecord | null {
    return this.byId.get(id) ?? null;
  }

  getSymbolAt(file: string, line: number, column: number, word: string): SymbolRecord | null {
    const candidates = this.byName.get(word) ?? [];
    const containingFunction = this.symbols.find((symbol) => symbol.kind === 'function' && symbol.definition?.file === file && contains(symbol.definition, line, column));
    return [...candidates].sort((a, b) => {
      const score = (symbol: SymbolRecord): number => {
        let value = 0;
        if (symbol.definition?.file === file && contains(symbol.definition, line, column)) value += symbol.name === word ? 90 : 5;
        if (symbol.declaration.file === file && contains(symbol.declaration, line, column)) value += 100;
        if (symbol.references.some((ref) => ref.range.file === file && contains(ref.range, line, column))) value += 80;
        if (symbol.declaration.file === file) value += 15;
        if (containingFunction && symbol.scope === containingFunction.name) value += 35;
        if (symbol.definition) value += 3;
        return value;
      };
      return score(b) - score(a);
    })[0] ?? null;
  }

  graph(input: { rootId?: string; query?: string; limit?: number } = {}): CallGraph {
    const limit = Math.max(10, Math.min(input.limit ?? 80, 250));
    const functions = this.symbols.filter((symbol) => symbol.kind === 'function' && symbol.definition);
    const incoming = new Map(functions.map((fn) => [fn.id, 0]));
    for (const fn of functions) for (const call of fn.calls) if (call.symbolId && incoming.has(call.symbolId)) incoming.set(call.symbolId, (incoming.get(call.symbolId) ?? 0) + 1);
    const isEventEntry = (fn: SymbolRecord): boolean => /(?:^main$|task|thread|startup|start|init|loop|service|process|callback|handler|irq|isr)/i.test(fn.name);
    const rootScore = (fn: SymbolRecord): number =>
      (fn.name === 'main' ? 10_000 : 0)
      + (isEventEntry(fn) ? 1_000 : 0)
      + (/\b(?:src|source|app|application)\b/i.test(fn.definition!.file.replaceAll('/', ' ')) ? 180 : 0)
      + (fn.origin.kind === 'unknown' || fn.origin.kind === 'ai-confirmed' ? 120 : -120)
      + Math.min(fn.calls.length, 40) * 5
      + ((incoming.get(fn.id) ?? 0) === 0 ? 50 : 0);
    const rootCap = Math.min(12, Math.max(1, Math.floor(limit / 4)));
    let rootSymbols = functions
      .filter((fn) => fn.name === 'main' || /(?:IRQ|ISR|Handler)$/i.test(fn.name) || (incoming.get(fn.id) ?? 0) === 0)
      .sort((a, b) => rootScore(b) - rootScore(a) || a.definition!.file.localeCompare(b.definition!.file) || a.name.localeCompare(b.name))
      .slice(0, rootCap);
    if (!rootSymbols.length) rootSymbols = [...functions].sort((a, b) => rootScore(b) - rootScore(a)).slice(0, rootCap);

    const selected = new Set<string>();
    const queue: string[] = [];
    const requestedRoot = input.rootId ? this.byId.get(input.rootId) : null;
    if (requestedRoot?.kind === 'function' && requestedRoot.definition) {
      rootSymbols = [requestedRoot];
      queue.push(requestedRoot.id);
    } else queue.push(...rootSymbols.map((root) => root.id));
    if (input.query) {
      const query = input.query.toLocaleLowerCase('ko-KR');
      const matches = functions.filter((candidate) => candidate.name.toLocaleLowerCase('ko-KR').includes(query)).slice(0, 6);
      for (const fn of [...matches].reverse()) queue.unshift(fn.id);
      rootSymbols = [...new Map([...matches, ...rootSymbols].map((fn) => [fn.id, fn])).values()].slice(0, rootCap);
    }
    while (queue.length && selected.size < limit) {
      const id = queue.shift()!;
      if (selected.has(id)) continue;
      selected.add(id);
      const fn = this.byId.get(id);
      for (const call of fn?.calls ?? []) {
        const target = call.symbolId ? this.byId.get(call.symbolId) : null;
        if (target?.definition && !selected.has(target.id)) queue.push(target.id);
      }
    }

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const externals = new Set<string>();
    const rootIds = new Set(rootSymbols.map((root) => root.id));
    for (const id of selected) {
      const fn = this.byId.get(id);
      if (!fn || fn.kind !== 'function' || !fn.definition) continue;
      nodes.push({
        id,
        name: fn.name,
        file: fn.definition.file,
        line: fn.definition.startLine,
        kind: /(?:IRQ|ISR|Handler)$/i.test(fn.name) ? 'irq' : rootIds.has(id) ? 'entry' : 'function',
        origin: fn.origin.kind,
      });
      for (const call of fn.calls) {
        const target = call.symbolId ? this.byId.get(call.symbolId) : null;
        if (target?.definition && selected.has(target.id)) edges.push({ from: id, to: target.id, range: call.range, resolved: true });
        else if (!call.resolved && nodes.length + externals.size < limit) {
          const externalId = `external:${call.name}`;
          externals.add(call.name);
          edges.push({ from: id, to: externalId, range: call.range, resolved: false });
        }
      }
    }
    for (const name of externals) nodes.push({ id: `external:${name}`, name, file: '', line: 0, kind: 'external', origin: 'unknown' });
    return {
      nodes,
      edges,
      roots: rootSymbols.map((root) => root.id),
      truncated: selected.size < functions.length || selected.size >= limit,
      limitations: [
        '정적 직접 호출 기준입니다.',
        '함수 포인터·콜백·매크로 경유 호출은 누락될 수 있습니다.',
        `전체 개요는 의미 있는 진입점 ${rootCap}개 이내를 우선 표시합니다.`,
      ],
    };
  }

  snapshot(files: ProjectFile[]): ProjectSnapshot {
    const concreteSymbols = this.symbols.filter((symbol) => !symbol.synthetic);
    const summaries: SymbolSummary[] = concreteSymbols.map((symbol) => ({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      file: symbol.definition?.file ?? symbol.declaration.file,
      line: symbol.definition?.startLine ?? symbol.declaration.startLine,
      origin: symbol.origin.kind,
    }));
    const typeKinds = new Set<SymbolKind>(['typedef', 'struct', 'union', 'enum']);
    return {
      rootName: path.basename(this.rootPath),
      rootPath: this.rootPath,
      files,
      symbols: summaries,
      stats: {
        files: files.length,
        functions: concreteSymbols.filter((symbol) => symbol.kind === 'function').length,
        variables: concreteSymbols.filter((symbol) => symbol.kind === 'variable' || symbol.kind === 'parameter').length,
        types: concreteSymbols.filter((symbol) => typeKinds.has(symbol.kind)).length,
        parseErrors: this.parsedFiles.reduce((sum, file) => sum + file.parseErrors, 0),
        indexedAt: new Date().toISOString(),
      },
      limitations: ['Tree-sitter 기반 원문 분석', '빌드 전처리 결과와 다를 수 있음', '함수 포인터·복잡한 매크로 호출은 제한적으로 표시'],
    };
  }
}
