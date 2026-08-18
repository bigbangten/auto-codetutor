import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type {
  AIEngine,
  AIJob,
  AIJobEvent,
  AIRequest,
  BackgroundAnalysisStatus,
  EngineInfo,
  FieldInfo,
  ProjectInsight,
  QuizQuestion,
  SourceRange,
  SymbolInsight,
  SymbolRecord,
} from '../shared/contracts.js';
import type { ProjectService } from './project-service.js';
import type { LearningStore } from './learning-store.js';

export interface Invocation {
  command: string;
  args: string[];
  cwd: string;
}

const CATALOG_BATCH_SIZE = 24;

export function prioritizeSemanticTargets(symbols: SymbolRecord[]): SymbolRecord[] {
  const priority = (symbol: SymbolRecord): number => {
    if (symbol.synthetic) return 100 + (symbol.kind === 'macro' ? 20 : 0);
    const primary = (symbol.definition ?? symbol.declaration).file.replaceAll('\\', '/');
    const location = /^src\//i.test(primary) ? 0 : 30;
    const origin = symbol.origin.kind === 'mex' ? 40 : symbol.origin.kind === 'rtd' ? 50 : 0;
    const kind = ({ function: 0, variable: 4, typedef: 8, struct: 8, union: 8, enum: 8, parameter: 12, field: 14, macro: 24 } as const)[symbol.kind];
    return location + origin + kind;
  };
  return [...symbols].sort((a, b) => priority(a) - priority(b)
    || (a.definition ?? a.declaration).file.localeCompare((b.definition ?? b.declaration).file)
    || (a.definition ?? a.declaration).startLine - (b.definition ?? b.declaration).startLine);
}

interface ExecutableSpec { command: string; prefix: string[] }

export function parseWindowsShim(cmdPath: string, content: string, nodeExecutable: string): ExecutableSpec | null {
  const native = content.match(/["']([A-Za-z]:[\\/][^"'\r\n]+\.exe)["']\s+%\*/i)?.[1];
  if (native) return { command: native, prefix: [] };
  const script = content.match(/%dp0%[\\/]([^"'\r\n]+\.js)/i)?.[1];
  if (script) return { command: nodeExecutable, prefix: [path.resolve(path.dirname(cmdPath), script)] };
  return null;
}

export function buildInvocation(request: AIRequest, root: string, executable: string = request.engine): Invocation {
  if (request.engine === 'codex') {
    const args = [
      'exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-rules', '--skip-git-repo-check',
      '--json', '-C', root,
      '-c', `model_reasoning_effort="${request.effort}"`,
    ];
    if (request.fast) args.push('-c', 'service_tier="fast"');
    if (request.model && request.model !== 'default') args.push('-m', request.model);
    args.push('-');
    return { command: executable, args, cwd: root };
  }
  const args = [
    '-p', '--safe-mode', '--permission-mode', 'plan', '--tools', 'Read,Glob,Grep',
    '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--effort', request.effort,
  ];
  if (request.model && request.model !== 'default') args.push('--model', request.model);
  return { command: executable, args, cwd: root };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…(길이 제한으로 생략)`;
}

function anchor(range: SourceRange): string {
  return `[[${range.file}:${range.startLine}${range.endLine !== range.startLine ? `-${range.endLine}` : ''}]]`;
}

function symbolContext(symbol: SymbolRecord): string {
  return [
    `이름: ${symbol.name}`,
    `종류: ${symbol.kind}`,
    `타입/반환형: ${symbol.type}`,
    symbol.signature ? `시그니처: ${symbol.signature}` : '',
    symbol.parameters.length ? `매개변수: ${symbol.parameters.map((parameter) => `${parameter.type} ${parameter.name}`).join(', ')}` : '',
    symbol.returnExpressions.length ? `반환식: ${symbol.returnExpressions.join(', ')}` : '',
    `정의: ${anchor(symbol.definition ?? symbol.declaration)}`,
    `출처: ${symbol.origin.label} (${symbol.origin.confidence}; ${symbol.origin.rule})`,
    `호출자: ${symbol.callers.slice(0, 12).map((item) => `${item.name}(${item.arguments?.join(', ') ?? ''}) ${anchor(item.range)}`).join(', ') || '없음/확인되지 않음'}`,
    `호출 대상: ${symbol.calls.slice(0, 15).map((item) => `${item.name} ${anchor(item.range)}${item.resolved ? '' : ' (미해결)'}`).join(', ') || '없음'}`,
    `주요 사용처: ${symbol.references.slice(0, 20).map((item) => `${item.kind}${item.target ? ` ${item.target}` : ''} ${anchor(item.range)}${item.changeDescription ? ` (${item.changeDescription})` : ''}`).join(', ') || '없음'}`,
    (symbol.fields.length || symbol.resolvedType?.fields.length) ? `내부 필드: ${(symbol.fields.length ? symbol.fields : symbol.resolvedType!.fields).map((field) => `${field.type} ${field.name} ${anchor(field.range)}`).join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

function fieldsFor(symbol: SymbolRecord): FieldInfo[] {
  return symbol.fields.length ? symbol.fields : symbol.resolvedType?.fields ?? [];
}

function flattenFields(fields: FieldInfo[], prefix = ''): Array<{ path: string; type: string; anchor: string }> {
  return fields.flatMap((field) => {
    const fieldPath = prefix ? `${prefix}.${field.name}` : field.name;
    return [
      { path: fieldPath, type: field.type, anchor: anchor(field.range) },
      ...flattenFields(field.children, fieldPath),
    ];
  });
}

function jsonObjectText(output: string): string {
  const unfenced = output.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 응답에서 JSON 객체를 찾지 못했습니다.');
  return unfenced.slice(start, end + 1);
}

function cleanSentence(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 700) : fallback;
}

export function parseProjectInsightOutput(output: string, sourceHash: string, model: string): ProjectInsight {
  const value = JSON.parse(jsonObjectText(output)) as Record<string, unknown>;
  const rawStages = Array.isArray(value.stages) ? value.stages : [];
  const stages = rawStages.slice(0, 6).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const title = cleanSentence(record.title, '주요 동작');
    const summary = cleanSentence(record.summary, '프로젝트의 사용자 기능을 수행합니다.');
    const focus: ProjectInsight['stages'][number]['focus'] = record.focus === 'platform' || record.focus === 'mixed' ? record.focus : 'user';
    return [{ title: title.slice(0, 60), summary, focus }];
  });
  const purpose = cleanSentence(value.purpose, '이 프로젝트의 사용자 기능을 수행합니다.');
  if (stages.length < 2) throw new Error('프로젝트 목적 단계가 충분하지 않습니다.');
  return { sourceHash, purpose, stages, model, updatedAt: new Date().toISOString() };
}

export function parseSymbolInsightOutput(output: string, requested: SymbolRecord[], model: string): SymbolInsight[] {
  const value = JSON.parse(jsonObjectText(output)) as Record<string, unknown>;
  const entries = Array.isArray(value.symbols) ? value.symbols : [];
  const byId = new Map(requested.map((symbol) => [symbol.id, symbol]));
  const seen = new Set<string>();
  const insights: SymbolInsight[] = [];
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const symbol = byId.get(id);
    if (!symbol || seen.has(id)) continue;
    seen.add(id);
    const meaning = cleanSentence(record.meaning, `${symbol.name}의 코드상 역할을 자동으로 확정하지 못했습니다.`);
    const typeDescription = cleanSentence(record.typeDescription, `${symbol.type} 타입의 코드상 의미는 정의와 사용 위치를 함께 확인해야 합니다.`);
    const impact = cleanSentence(record.impact, '수정 전 호출 및 참조 위치를 함께 확인해야 합니다.');
    const caveat = cleanSentence(record.caveat, '정적 코드와 이름을 근거로 한 설명입니다. 런타임 값은 디버거로 확인해야 합니다.');
    const parameterDescriptions: Record<string, string> = {};
    if (Array.isArray(record.parameters)) {
      for (const parameter of record.parameters) {
        if (!parameter || typeof parameter !== 'object') continue;
        const parameterRecord = parameter as Record<string, unknown>;
        const name = typeof parameterRecord.name === 'string' ? parameterRecord.name.trim() : '';
        const description = cleanSentence(parameterRecord.description, '');
        if (name && description) parameterDescriptions[name] = description;
      }
    } else if (record.parameters && typeof record.parameters === 'object') {
      for (const [name, description] of Object.entries(record.parameters as Record<string, unknown>)) {
        const cleaned = cleanSentence(description, '');
        if (name.trim() && cleaned) parameterDescriptions[name.trim()] = cleaned;
      }
    }
    const returnDescription = cleanSentence(
      record.returnDescription,
      symbol.kind === 'function'
        ? /\bvoid\b/.test(symbol.type) ? '반환값이 없는 함수입니다.' : `${symbol.type} 형식의 값을 반환합니다.`
        : '함수가 아닌 심볼에는 반환값이 없습니다.',
    );
    const fieldDescriptions: Record<string, string> = {};
    if (Array.isArray(record.fields)) {
      for (const field of record.fields) {
        if (!field || typeof field !== 'object') continue;
        const fieldRecord = field as Record<string, unknown>;
        const fieldPath = typeof fieldRecord.path === 'string' ? fieldRecord.path.trim() : '';
        const description = cleanSentence(fieldRecord.description, '');
        if (fieldPath && description) fieldDescriptions[fieldPath] = description;
      }
    } else if (record.fields && typeof record.fields === 'object') {
      for (const [fieldPath, description] of Object.entries(record.fields as Record<string, unknown>)) {
        const cleaned = cleanSentence(description, '');
        if (fieldPath.trim() && cleaned) fieldDescriptions[fieldPath.trim()] = cleaned;
      }
    }
    const definition = symbol.definition ?? symbol.declaration;
    const markdown = [
      '### 코드에서 하는 일',
      `${meaning} ${anchor(definition)}`,
      '',
      '### 데이터 타입',
      typeDescription,
      '',
      '### 값을 바꾸면',
      impact,
      '',
      '### 확인 범위',
      caveat,
    ].join('\n');
    insights.push({
      symbolId: symbol.id,
      sourceHash: symbol.sourceHash,
      meaning,
      typeDescription,
      parameterDescriptions,
      returnDescription,
      impact,
      caveat,
      markdown,
      fieldDescriptions,
      model,
      updatedAt: new Date().toISOString(),
    });
  }
  if (!insights.length) throw new Error('AI 응답에서 요청한 심볼 설명을 찾지 못했습니다.');
  return insights;
}

async function buildCatalogPrompt(request: AIRequest, project: ProjectService): Promise<string> {
  const snapshot = project.snapshot();
  if (!snapshot) throw new Error('프로젝트를 먼저 여세요.');
  if (request.catalogMode === 'project-profile') {
    const srcFiles = snapshot.files.filter((file) => /(?:^|\/)src\//i.test(file.path) && file.kind !== 'mex').map((file) => file.path);
    return `당신은 임베디드 C 프로젝트를 처음 공부하는 사용자를 위한 코드 분석가입니다.
이 작업은 읽기 전용입니다. 프로젝트 파일을 수정하지 마세요. rg, Get-Content/cat 같은 읽기 명령으로 실제 src 코드를 조사하세요.

[목표]
프로젝트가 사용자 관점에서 무엇을 하는지 한 문장으로 밝히고, 실제 제품 동작을 3~6개의 큰 단계로 요약하세요.
함수 이름이나 초기화 세부 절차를 제목으로 나열하지 마세요. 예: "SQI 품질 측정", "케이블 상태 판정", "Ethernet 진단 메시지 전송"처럼 사용자가 이해할 수 있는 기능으로 쓰세요.
src 폴더의 사용자 로직을 중심으로 보고 RTD/MEX/SDK 코드는 그 기능을 돕는 플랫폼 계층일 때만 언급하세요.
확인되지 않은 목적을 추측으로 단정하지 마세요.

[프로젝트]
이름: ${snapshot.rootName}
src 후보: ${srcFiles.slice(0, 300).join(', ')}

오직 아래 형식의 JSON 객체만 반환하세요. 마크다운이나 설명 문장은 JSON 밖에 쓰지 마세요.
{"purpose":"프로젝트의 실제 목적 한 문장","stages":[{"title":"사용자 기능 단계","summary":"이 단계가 목적 달성에 기여하는 방식","focus":"user"}]}
focus는 src 사용자 로직이면 user, RTD/MEX/SDK 중심이면 platform, 둘을 연결하면 mixed입니다.`;
  }

  const requested = (request.symbolIds ?? []).map((id) => project.getSymbol(id)).filter((symbol): symbol is SymbolRecord => Boolean(symbol));
  if (!requested.length) throw new Error('분석할 심볼이 없습니다.');
  const sourceFile = request.analysisFile ?? (requested[0]!.definition ?? requested[0]!.declaration).file;
  const source = await project.readSource(sourceFile);
  const inventory = requested.map((symbol) => ({
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind,
    type: clip(symbol.type, 500),
    signature: symbol.signature ? clip(symbol.signature, 700) : undefined,
    macro: symbol.macro ? {
      functionLike: symbol.macro.functionLike,
      parameters: symbol.macro.parameters,
      replacement: clip(symbol.macro.replacement, 700),
      expandedReplacement: symbol.macro.expandedReplacement ? clip(symbol.macro.expandedReplacement, 700) : undefined,
    } : undefined,
    scope: symbol.scope,
    definition: anchor(symbol.definition ?? symbol.declaration),
    callers: symbol.callers.slice(0, 10).map((call) => call.name),
    callSites: symbol.callers.slice(0, 10).map((call) => ({ caller: call.name, arguments: call.arguments ?? [], anchor: anchor(call.range) })),
    calls: symbol.calls.slice(0, 12).map((call) => call.name),
    parameters: symbol.parameters.map((parameter) => ({ name: parameter.name, type: parameter.type, anchor: anchor(parameter.range) })),
    returnExpressions: symbol.returnExpressions,
    writes: symbol.references.filter((reference) => reference.kind === 'write').slice(0, 12).map((reference) => {
      const base = reference.changeDescription ?? reference.expression ?? anchor(reference.range);
      return reference.valueExpression && reference.expandedValue
        ? `${base} (매크로 치환: ${reference.valueExpression} → ${reference.expandedValue})`
        : base;
    }),
    fields: flattenFields(fieldsFor(symbol)),
  }));
  return `당신은 임베디드 C/S32DS 프로젝트를 공부하는 사용자를 위한 한국어 코드 분석가입니다.
이 작업은 읽기 전용이며 파일을 수정하면 안 됩니다. 아래 소스는 한 번만 제공되며, 같은 파일의 여러 심볼을 한꺼번에 설명해야 합니다.

[설명 원칙]
- meaning: 함수라면 입력-핵심처리-출력, 변수라면 실제로 담는 값과 단위를 1~3문장으로 설명합니다.
- typeDescription: uint8_t 같은 기본 타입은 비트 폭·부호·범위를, status_t/err_t 같은 SDK 타입은 성공·오류 등 이 프로젝트에서의 의미를 설명합니다.
- parameters: 함수의 모든 매개변수가 호출자에게서 무엇을 받고 함수 안에서 어떻게 쓰이는지 이름별로 설명합니다. 매개변수가 없으면 빈 배열입니다.
- 프로젝트 내부 선언이 없지만 callSites에 인자가 있으면 무인자 함수라고 쓰지 마세요. 관찰된 순서대로 arg1, arg2 같은 이름을 사용해 각 전달값의 역할을 설명하고, 정확한 선언 타입은 미확인이라고 구분하세요.
- returnDescription: 함수가 무엇을 반환하고 호출자가 그 값을 어떻게 해석하는지 설명합니다. void면 반환값이 없다고 명시합니다.
- impact: 이 값을 수정하거나 동작을 바꾸면 어떤 판정·메시지·하드웨어 동작에 영향이 가는지 설명합니다.
- caveat: 정적 분석으로 확인할 수 없는 런타임/하드웨어 조건만 짧게 씁니다.
- fields: 구조체/공용체/타입 또는 해당 타입의 변수에 내부 필드가 있으면 모든 field path별 의미를 짧게 설명합니다. 필드명 번역이 아니라 이 프로젝트에서의 용도를 설명하세요.
- 사실과 추정을 구분하고, 심볼 ID는 아래 값을 한 글자도 바꾸지 마세요.

[파일: ${sourceFile}]
\`\`\`c
${clip(source, 120_000)}
\`\`\`

[분석 대상]
${JSON.stringify(inventory)}

오직 아래 형식의 JSON 객체만 반환하세요. JSON 밖에 마크다운을 쓰지 마세요.
{"symbols":[{"id":"제공된 ID","meaning":"코드에서 하는 일/담는 값","typeDescription":"타입의 비트 폭·범위 또는 프로젝트 의미","parameters":[{"name":"매개변수명","description":"입력값의 의미와 사용 방식"}],"returnDescription":"반환값과 호출자 관점의 의미","impact":"수정 영향","caveat":"확인 한계","fields":[{"path":"필드 또는 중첩.필드","description":"프로젝트에서 의미하는 값"}]}]}`;
}

async function buildPrompt(request: AIRequest, project: ProjectService, learning: LearningStore): Promise<string> {
  if (request.kind === 'catalog') return buildCatalogPrompt(request, project);
  const symbol = request.symbolId ? project.getSymbol(request.symbolId) : null;
  const selection = request.selection;
  const snapshot = project.snapshot();
  const projectGraph = !symbol && !selection ? project.currentIndex?.graph({ limit: 80 }) : null;
  const entryNames = projectGraph?.nodes
    .filter((node) => node.kind === 'entry' || node.kind === 'irq')
    .slice(0, 12)
    .map((node) => `${node.name} [[${node.file}:${node.line}]]`)
    .join(', ');
  const projectContext = snapshot ? [
    '[프로젝트 전체]',
    `프로젝트: ${snapshot.rootName}`,
    `규모: C/헤더/MEX ${snapshot.stats.files}개, 함수 ${snapshot.stats.functions}개, 변수 ${snapshot.stats.variables}개, 타입 ${snapshot.stats.types}개`,
    `주요 진입점: ${entryNames || '정적 분석에서 명확한 진입점을 찾지 못함'}`,
    `대표 파일 후보: ${snapshot.files.slice(0, 180).map((file) => file.path).join(', ')}`,
    snapshot.files.length > 180 ? `그 외 ${snapshot.files.length - 180}개 파일` : '',
    '질문 범위는 프로젝트 전체입니다. 위 목록만 보고 추측하지 말고 실제 소스에서 진입점, 태스크 생성, 초기화, 반복 처리 경로를 확인하세요.',
  ].filter(Boolean).join('\n') : '';
  const referenceQuery = [request.question, symbol?.name, symbol?.type, selection?.text.slice(0, 600)].filter(Boolean).join(' ');
  const referenceHits = request.kind === 'comment' ? [] : project.searchReferences(referenceQuery, 6);
  const referenceContext = referenceHits.length ? [
    '[레퍼런스 문서 검색 결과]',
    ...referenceHits.map((hit) => `${hit.citation} ${hit.excerpt}`),
    '문서 내용이 질문과 직접 관련될 때만 사용하고, 사용한 주장 바로 뒤에 문서 페이지 앵커를 붙이세요.',
  ].join('\n') : '';
  const readTools = request.engine === 'codex'
    ? '프로젝트 조사를 위해 읽기 전용 명령(예: rg --files, rg, Get-Content 또는 cat)은 실행해도 됩니다. 쓰기·빌드·실행 명령은 사용하지 마세요.'
    : '프로젝트 조사를 위해 Read, Glob, Grep 도구를 사용해도 됩니다. Edit, Write, Bash 등 변경 도구는 사용하지 마세요.';
  const common = `당신은 임베디드 C/S32DS 코드를 공부하는 한국어 튜터입니다.
이 작업은 읽기 전용 코드 조사입니다. ${readTools}
확인한 사실과 추정을 구분하고, 근거 없는 작성자 판정을 하지 마세요.
코드 근거는 반드시 프로젝트 상대 경로 형식 [[경로:줄]] 또는 [[경로:시작-끝]]으로 표시하세요.
레퍼런스 문서 근거는 [[문서상대경로:p.페이지]] 형식으로 표시하세요.
절대 경로는 답변에 쓰지 마세요. 제공된 근거에 없는 줄 번호를 지어내지 마세요.
전처리, 함수 포인터, 매크로 때문에 확실하지 않으면 한계를 명시하세요.`;
  const context = [
    symbol ? `[선택 심볼]\n${symbolContext(symbol)}` : '',
    selection ? `[선택 코드 ${selection.file}:${selection.startLine}-${selection.endLine}]\n${clip(selection.text, request.kind === 'comment' ? 80_000 : 16_000)}` : '',
    !symbol && !selection ? projectContext : '',
    referenceContext,
  ].filter(Boolean).join('\n\n');

  if (request.kind === 'comment') {
    const mode = request.commentMode === 'replace'
      ? '기존 // 및 /* */ 주석을 모두 제거한 뒤 새 주석으로 대체'
      : request.commentMode === 'custom'
        ? '아래 사용자 요청을 최우선으로 따라 주석을 작성'
        : request.commentMode === 'remove'
          ? '기존 // 및 /* */ 주석을 모두 제거하고 새 주석은 추가하지 않음'
          : '기존 주석은 그대로 유지하고 필요한 새 주석만 추가';
    const language = request.commentLanguage === 'en' ? '영어' : '한국어';
    const customInstruction = request.commentInstruction?.trim()
      ? `\n[사용자 추가 요청 — 언어와 상세도 지시를 포함해 최우선 적용]\n${clip(request.commentInstruction.trim(), 2_000)}`
      : '';
    return `당신은 임베디드 C 코드를 공부하기 쉽게 주석을 작성하는 한국어 튜터입니다.
파일을 읽거나 수정하지 말고, 아래에 제공된 대상 코드만 변환하세요.\n\n${context}\n\n[주석 생성 작업]
${mode}하세요. 기본 주석 언어는 ${language}입니다.${customInstruction}
함수·변수 이름, 리터럴, 연산자, 전처리문, 코드 순서와 공백 외의 코드 토큰을 절대 바꾸지 마세요.
자명한 줄마다 주석을 달지 말고, 의도·단위·비트 배치·부작용·동시성처럼 학습에 필요한 이유를 설명하세요.
출력은 설명 없이 적용할 전체 대상 코드 하나만 \`\`\`c 코드 블록으로 반환하세요.`;
  }

  if (request.kind === 'summary') {
    return `${common}\n\n${context}\n\n선택 심볼의 의미를 짧고 구체적으로 분석하세요.
### 코드에서 하는 일
함수면 입력→처리→출력, 변수면 실제로 담기는 값과 단위를 2~4문장으로 설명하세요.
### 수정 시 영향
이 값을 바꾸거나 함수 동작을 바꿀 때 어떤 출력·상태·호출 경로가 영향을 받는지 설명하세요.
### 확인할 점
추정과 정적 분석 한계를 한 문장으로 명시하세요.
각 주장 바로 뒤에 코드 앵커를 붙이고, 선언문을 그대로 풀어 읽는 설명은 피하세요.`;
  }

  if (request.kind === 'explain') {
    const scopeInstruction = !symbol && !selection
      ? '구체적인 대상을 사용자에게 되묻지 마세요. 먼저 읽기 도구로 main, 태스크 생성부, 초기화부와 애플리케이션 소스의 대표 파일을 직접 찾으세요. 세부 보조 함수 이름을 길게 나열하지 말고, 확인한 전체 동작을 4~7개의 실행 단계로 요약한 뒤 각 단계마다 대표 함수와 모듈만 제시하세요.'
      : '선택 범위를 프로젝트 전체 실행 흐름 속에서 어디에 위치하는지 먼저 알려주세요.';
    return `${common}\n\n${context}\n\n${scopeInstruction}\n다음 순서로 초보자도 이해할 수 있게 설명하세요.
1. 한 문장 역할
2. 입력 → 핵심 처리 → 출력/부작용의 실행 흐름
3. 호출자와 피호출 함수가 전체 흐름에서 연결되는 방식
4. 변수·구조체·union 필드 중 이해에 중요한 것
5. 출처 판정 근거와 분석 한계
각 설명 문단 바로 옆에 관련 코드 앵커를 붙이세요.`;
  }

  if (request.kind === 'quiz') {
    return `${common}\n\n${context}\n\n이 심볼을 정말 이해했는지 확인하는 질문 정확히 3개를 만드세요.
단순 암기보다 실행 흐름, 데이터 의미, 호출 관계를 묻고 초보자가 한두 문장으로 답할 수 있게 하세요.
출력은 다른 문장이나 마크다운 없이 다음 JSON 배열만 반환하세요:
[{"question":"질문","expected":"모범 설명","anchor":"[[상대경로:줄-줄]]"}]`;
  }

  const chat = request.chatId ? await learning.getChat(request.chatId) : null;
  const allMessages = chat?.messages ?? [];
  const withoutCurrent = allMessages.at(-1)?.role === 'user' && allMessages.at(-1)?.content === request.question?.trim()
    ? allMessages.slice(0, -1)
    : allMessages;
  const history = withoutCurrent.slice(-8).map((message) => `${message.role === 'user' ? '사용자' : '튜터'}: ${clip(message.content, 3000)}`).join('\n\n');
  return `${common}\n\n${context}\n\n${history ? `[이전 대화]\n${history}\n\n` : ''}[현재 질문]\n${request.question?.trim() || '선택한 코드를 설명해 주세요.'}\n\n먼저 결론을 말하고, 코드 근거를 해당 주장 바로 뒤에 붙이세요.`;
}

export function extractJsonText(engine: AIEngine, line: string): { text: string; final: boolean; replace?: boolean } {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return { text: line.trim() ? `${line}\n` : '', final: false }; }
  if (!value || typeof value !== 'object') return { text: '', final: false };
  const record = value as Record<string, unknown>;
  if (engine === 'codex') {
    const item = record.item as Record<string, unknown> | undefined;
    if (record.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') return { text: item.text, final: true, replace: true };
    if (record.type === 'response.output_text.delta' && typeof record.delta === 'string') return { text: record.delta, final: false };
    return { text: '', final: false };
  }
  if (record.type === 'stream_event') {
    const event = record.event as Record<string, unknown> | undefined;
    const delta = event?.delta as Record<string, unknown> | undefined;
    if (event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') return { text: delta.text, final: false };
  }
  if (record.type === 'result' && typeof record.result === 'string') return { text: record.result, final: true };
  return { text: '', final: false };
}

function parseQuizMarkdown(output: string): Array<Pick<QuizQuestion, 'question' | 'expected' | 'anchor'>> {
  const withoutFence = output.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = withoutFence.indexOf('[');
  const end = withoutFence.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1)) as Array<Record<string, unknown>>;
    return parsed.filter((item) => typeof item.question === 'string' && typeof item.expected === 'string').slice(0, 3).map((item) => {
      const raw = typeof item.anchor === 'string' ? item.anchor.match(/^\[\[([^:]+):(\d+)(?:-(\d+))?\]\]$/) : null;
      return {
        question: String(item.question),
        expected: String(item.expected),
        anchor: raw ? {
          file: raw[1]!, startLine: Number(raw[2]), startColumn: 1,
          endLine: Number(raw[3] ?? raw[2]), endColumn: 1,
        } : undefined,
      };
    });
  } catch { return []; }
}

async function whereExecutables(name: string): Promise<string[]> {
  if (process.platform !== 'win32') return [name];
  return new Promise((resolve) => {
    const child = spawn('where.exe', [name], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const candidates = output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      resolve(candidates);
    });
  });
}

async function resolveExecutable(name: AIEngine): Promise<ExecutableSpec> {
  if (process.platform !== 'win32') return { command: name, prefix: [] };
  const candidates = await whereExecutables(name);
  const native = candidates.find((candidate) => candidate.toLocaleLowerCase('en-US').endsWith('.exe'));
  if (native) return { command: native, prefix: [] };
  const shim = candidates.find((candidate) => candidate.toLocaleLowerCase('en-US').endsWith('.cmd'));
  if (shim) {
    const node = (await whereExecutables('node')).find((candidate) => candidate.toLocaleLowerCase('en-US').endsWith('.exe')) ?? 'node.exe';
    const parsed = parseWindowsShim(shim, await readFile(shim, 'utf8'), node);
    if (parsed) return parsed;
  }
  throw new Error(`${name} CLI의 안전하게 실행 가능한 .exe 또는 npm shim을 찾지 못했습니다.`);
}

async function versionOf(engine: AIEngine): Promise<{ installed: boolean; version: string; executable: ExecutableSpec | null }> {
  let executable: ExecutableSpec;
  try { executable = await resolveExecutable(engine); }
  catch { return { installed: false, version: '', executable: null }; }
  return new Promise((resolve) => {
    const child = spawn(executable.command, [...executable.prefix, '--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), 4000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve({ installed: false, version: '', executable }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ installed: code === 0, version: output.trim().split(/\r?\n/)[0] ?? '', executable }); });
  });
}

const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function modelInfo(id: string, efforts: string[], label = id, description?: string): EngineInfo['models'][number] {
  return { id, label, efforts, description };
}

async function codexModels(): Promise<EngineInfo['models']> {
  const models = new Map<string, EngineInfo['models'][number]>();
  models.set('default', modelInfo('default', CODEX_EFFORTS, 'CLI 기본 모델', '설치된 Codex CLI의 기본 설정을 사용합니다.'));
  try {
    const cache = JSON.parse(await readFile(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8')) as {
      models?: Array<{ slug?: string; display_name?: string; description?: string; supported_reasoning_levels?: Array<{ effort?: string }> }>;
    };
    for (const item of cache.models ?? []) {
      if (!item.slug) continue;
      // Work-mode/review entries are internal routing targets rather than
      // useful base-model choices for a user-facing selector.
      if (/-wm$/i.test(item.slug) || /^codex-auto-review$/i.test(item.slug)) continue;
      const efforts = (item.supported_reasoning_levels ?? []).map((level) => level.effort).filter((value): value is string => Boolean(value));
      models.set(item.slug, modelInfo(item.slug, efforts.length ? efforts : CODEX_EFFORTS, item.display_name || item.slug, item.description));
    }
  } catch { /* Older CLI versions may not have a model cache. */ }
  try {
    const config = await readFile(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    for (const match of config.matchAll(/^model\s*=\s*["']([^"']+)["']/gm)) {
      const id = match[1]?.trim();
      if (id && !models.has(id)) models.set(id, modelInfo(id, CODEX_EFFORTS));
    }
  } catch { /* Configuration is optional. */ }
  return [...models.values()];
}

function collectClaudeModels(value: unknown, output: Set<string>, key = ''): void {
  if (Array.isArray(value)) { value.forEach((item) => collectClaudeModels(item, output, key)); return; }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (childKey.toLocaleLowerCase('en-US') === 'model' && typeof child === 'string') {
      const cleaned = child.replace(/\[[\d;]*m$/g, '').trim();
      if (/^(?:claude-[a-z0-9._-]+|sonnet|fable|opus|haiku)$/i.test(cleaned) && !/no-such/i.test(cleaned)) output.add(cleaned);
    }
    collectClaudeModels(child, output, childKey);
  }
}

async function claudeModels(): Promise<EngineInfo['models']> {
  const found = new Set(['default', 'sonnet', 'fable', 'opus', 'haiku']);
  const candidates = [
    path.join(os.homedir(), '.claude.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.local.json'),
  ];
  for (const file of candidates) {
    try { collectClaudeModels(JSON.parse(await readFile(file, 'utf8')), found); } catch { /* Local file is optional or non-JSON. */ }
  }
  const aliasLabels: Record<string, [string, string]> = {
    default: ['CLI 기본 모델', 'Claude Code의 현재 기본 설정을 사용합니다.'],
    sonnet: ['Sonnet · 최신 별칭', '설치된 Claude Code가 제공하는 최신 Sonnet을 사용합니다.'],
    fable: ['Fable · 최신 별칭', '설치된 Claude Code가 제공하는 최신 Fable을 사용합니다.'],
    opus: ['Opus · 최신 별칭', '설치된 Claude Code가 제공하는 최신 Opus를 사용합니다.'],
    haiku: ['Haiku · 최신 별칭', '설치된 Claude Code가 제공하는 최신 Haiku를 사용합니다.'],
  };
  return [...found].map((id) => {
    const alias = aliasLabels[id];
    return modelInfo(id, CLAUDE_EFFORTS, alias?.[0] ?? id, alias?.[1]);
  });
}

export class AIRunner {
  private readonly emitter = new EventEmitter();
  private readonly analysisEmitter = new EventEmitter();
  private readonly jobs = new Map<string, AIJob>();
  private readonly requests = new Map<string, AIRequest>();
  private readonly prompts = new Map<string, string>();
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly queue: string[] = [];
  private running = 0;
  private readonly concurrency = 2;
  private executables = new Map<AIEngine, ExecutableSpec>();
  private readonly catalogProjectHashes = new Map<string, string>();
  private readonly backgroundJobs = new Set<string>();
  private backgroundProjectHash = '';
  private analysisStatus: BackgroundAnalysisStatus = {
    state: 'idle', model: 'gpt-5.6-terra', effort: 'low', fast: true,
    total: 0, completed: 0, cached: 0, failed: 0, profileReady: false,
    message: '프로젝트를 열면 src의 모든 인덱스 심볼을 백그라운드에서 분석합니다.',
  };

  constructor(private readonly project: ProjectService, private readonly learning: LearningStore) {}

  onEvent(listener: (event: AIJobEvent) => void): () => void {
    this.emitter.on('job', listener);
    return () => this.emitter.off('job', listener);
  }

  onBackgroundAnalysis(listener: (status: BackgroundAnalysisStatus) => void): () => void {
    this.analysisEmitter.on('analysis', listener);
    return () => this.analysisEmitter.off('analysis', listener);
  }

  backgroundStatus(): BackgroundAnalysisStatus { return { ...this.analysisStatus }; }

  private emitAnalysis(changes: Partial<BackgroundAnalysisStatus> = {}): void {
    this.analysisStatus = { ...this.analysisStatus, ...changes };
    this.analysisEmitter.emit('analysis', this.backgroundStatus());
  }

  private emit(type: AIJobEvent['type'], job: AIJob, chunk?: string): void {
    this.emitter.emit('job', { type, job: { ...job }, chunk } satisfies AIJobEvent);
  }

  async engines(): Promise<EngineInfo[]> {
    const [codex, claude] = await Promise.all([versionOf('codex'), versionOf('claude')]);
    if (codex.executable) this.executables.set('codex', codex.executable);
    if (claude.executable) this.executables.set('claude', claude.executable);
    return [
      { engine: 'codex', installed: codex.installed, version: codex.version, models: await codexModels(), efforts: CODEX_EFFORTS, supportsFast: true },
      { engine: 'claude', installed: claude.installed, version: claude.version, models: await claudeModels(), efforts: CLAUDE_EFFORTS, supportsFast: false },
    ];
  }

  list(): AIJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((job) => ({ ...job }));
  }

  private async catalogAI(): Promise<Pick<AIRequest, 'engine' | 'model' | 'effort' | 'fast'>> {
    const models = await codexModels();
    const ids = models.map((model) => model.id);
    const model = ids.find((id) => /^gpt-5\.6-terra(?:$|-)/i.test(id))
      ?? ids.find((id) => /^gpt-5\.6-luna(?:$|-)/i.test(id))
      ?? ids.find((id) => /^gpt-5\.6-sol(?:$|-)/i.test(id))
      ?? 'default';
    return { engine: 'codex', model, effort: 'low', fast: true };
  }

  private enqueue(request: AIRequest, prompt: string, position: 'front' | 'back' = 'back', autoPump = true): AIJob {
    const job: AIJob = {
      id: crypto.randomUUID(), kind: request.kind, engine: request.engine, model: request.model || 'default',
      state: 'queued', createdAt: new Date().toISOString(), symbolId: request.symbolId, chatId: request.chatId,
      analysisFile: request.analysisFile, batchSize: request.symbolIds?.length, output: '',
    };
    this.jobs.set(job.id, job);
    this.requests.set(job.id, request);
    this.prompts.set(job.id, prompt);
    if (position === 'front') this.queue.unshift(job.id); else this.queue.push(job.id);
    this.emit('created', job);
    if (autoPump) this.pump();
    return job;
  }

  async startBackgroundAnalysis(): Promise<BackgroundAnalysisStatus> {
    if (!this.project.root || !this.project.snapshot()) throw new Error('프로젝트를 먼저 여세요.');
    const projectHash = this.project.semanticSourceHash();
    if (projectHash === this.backgroundProjectHash && this.backgroundJobs.size) return this.backgroundStatus();
    await this.cancelBackgroundAnalysis(false);
    this.learning.setAllowStaleSemantic(false);
    // Record the exact project snapshot before enqueueing. If the app closes halfway
    // through, the next launch can resume only the missing symbols without discarding
    // the batches that were already written to disk.
    await this.learning.markSemanticBaseline(projectHash);
    const targets = this.project.semanticTargets();
    const cachedIds = await this.learning.getCachedSymbolIds(targets);
    const cachedProject = await this.learning.getProjectInsight(projectHash);
    const ai = await this.catalogAI();
    this.backgroundProjectHash = projectHash;
    this.analysisStatus = {
      state: 'queued', model: ai.model, effort: ai.effort, fast: ai.fast,
      total: targets.length, completed: cachedIds.size, cached: cachedIds.size, failed: 0,
      profileReady: Boolean(cachedProject),
      message: cachedIds.size
        ? `저장된 설명 ${cachedIds.size.toLocaleString('ko-KR')}개를 불러왔습니다. 사용자 코드부터 확인합니다.`
        : '프로젝트 목적을 확인한 뒤 사용자 코드 심볼부터 분석합니다.',
    };

    const requests: AIRequest[] = [];
    if (!cachedProject) requests.push({ kind: 'catalog', catalogMode: 'project-profile', ...ai });
    const missing = prioritizeSemanticTargets(targets.filter((symbol) => !cachedIds.has(symbol.id)));
    const byFile = new Map<string, SymbolRecord[]>();
    for (const symbol of missing) {
      const file = this.project.semanticFileFor(symbol);
      const list = byFile.get(file) ?? [];
      list.push(symbol); byFile.set(file, list);
    }
    for (const [file, symbols] of byFile) {
      for (let index = 0; index < symbols.length; index += CATALOG_BATCH_SIZE) {
        requests.push({
          kind: 'catalog', catalogMode: 'symbol-batch', symbolIds: symbols.slice(index, index + CATALOG_BATCH_SIZE).map((symbol) => symbol.id),
          analysisFile: file, ...ai,
        });
      }
    }

    if (requests.length) this.emitAnalysis({ state: 'queued', message: `미분석 심볼 ${missing.length.toLocaleString('ko-KR')}개를 사용자 코드 우선 순서로 준비했습니다.` });
    for (const request of requests) {
      const prompt = await buildPrompt(request, this.project, this.learning);
      const job = this.enqueue(request, prompt, 'back', false);
      this.catalogProjectHashes.set(job.id, projectHash);
      this.backgroundJobs.add(job.id);
    }
    if (!requests.length) {
      this.emitAnalysis({ state: 'done', message: `src 전체 심볼 ${targets.length.toLocaleString('ko-KR')}개의 설명이 준비되었습니다.` });
    } else this.pump();
    return this.backgroundStatus();
  }

  async restartBackgroundAnalysis(): Promise<BackgroundAnalysisStatus> {
    if (!this.project.root || !this.project.snapshot()) throw new Error('프로젝트를 먼저 여세요.');
    await this.cancelBackgroundAnalysis(false);
    const manualCatalogJobs = [...this.jobs.values()]
      .filter((job) => job.kind === 'catalog' && ['queued', 'running'].includes(job.state))
      .map((job) => job.id);
    await Promise.all(manualCatalogJobs.map((id) => this.cancel(id)));
    await this.learning.resetSemanticCatalog();
    this.backgroundProjectHash = '';
    return this.startBackgroundAnalysis();
  }

  async cancelBackgroundAnalysis(disabled = true): Promise<BackgroundAnalysisStatus> {
    const ids = [...this.backgroundJobs];
    this.backgroundJobs.clear();
    await Promise.all(ids.map((id) => this.cancel(id)));
    this.backgroundProjectHash = '';
    if (disabled) {
      this.emitAnalysis({ state: 'disabled', currentFile: undefined, message: '백그라운드 사전 분석이 꺼져 있습니다. 개별 심볼 분석은 계속 사용할 수 있습니다.' });
    }
    return this.backgroundStatus();
  }

  async resetProjectContext(): Promise<BackgroundAnalysisStatus> {
    await this.cancelBackgroundAnalysis(false);
    const activeJobs = this.list()
      .filter((job) => job.state === 'queued' || job.state === 'running')
      .map((job) => job.id);
    await Promise.all(activeJobs.map((id) => this.cancel(id)));
    this.emitAnalysis({
      state: 'idle', model: 'gpt-5.6-terra', effort: 'low', fast: true,
      total: 0, completed: 0, cached: 0, failed: 0, profileReady: false,
      currentFile: undefined,
      message: '프로젝트를 열면 src의 모든 인덱스 심볼을 백그라운드에서 분석합니다.',
    });
    return this.backgroundStatus();
  }

  async symbolInsight(symbolId: string): Promise<SymbolInsight | null> {
    const symbol = this.project.getSymbol(symbolId);
    return symbol ? this.learning.getSymbolInsight(symbol) : null;
  }

  async projectInsight(): Promise<ProjectInsight | null> {
    return this.project.root ? this.learning.getProjectInsight(this.project.semanticSourceHash()) : null;
  }

  async analyzeSymbol(symbolId: string): Promise<AIJob> {
    const symbol = this.project.getSymbol(symbolId);
    if (!symbol) throw new Error('현재 인덱스에서 심볼을 찾을 수 없습니다.');
    const cached = await this.learning.getSymbolInsight(symbol);
    if (cached) {
      const job: AIJob = {
        id: crypto.randomUUID(), kind: 'catalog', engine: 'codex', model: cached.model,
        state: 'done', createdAt: cached.updatedAt, finishedAt: cached.updatedAt,
        symbolId, analysisFile: this.project.semanticFileFor(symbol), batchSize: 1, output: cached.markdown,
      };
      this.jobs.set(job.id, job); this.emit('created', job); this.emit('updated', job); return { ...job };
    }
    const pending = [...this.jobs.values()].find((job) => {
      if (job.kind !== 'catalog' || !['queued', 'running'].includes(job.state)) return false;
      return this.requests.get(job.id)?.symbolIds?.includes(symbolId);
    });
    if (pending) {
      const position = this.queue.indexOf(pending.id);
      if (position > 0) { this.queue.splice(position, 1); this.queue.unshift(pending.id); }
      return { ...pending };
    }
    const ai = await this.catalogAI();
    const request: AIRequest = {
      kind: 'catalog', catalogMode: 'symbol-batch', symbolIds: [symbolId], symbolId,
      analysisFile: this.project.semanticFileFor(symbol), ...ai,
    };
    const job = this.enqueue(request, await buildPrompt(request, this.project, this.learning), 'front', false);
    this.catalogProjectHashes.set(job.id, this.project.semanticSourceHash());
    this.pump();
    return { ...job };
  }

  async start(request: AIRequest): Promise<AIJob> {
    const root = this.project.root;
    if (!root) throw new Error('프로젝트를 먼저 여세요.');
    if (request.kind === 'quiz' && !request.symbolId) throw new Error('이해도 체크를 만들 함수를 먼저 선택하세요.');
    if (request.kind === 'summary' && !request.symbolId) throw new Error('AI로 분석할 심볼을 먼저 선택하세요.');
    if (request.kind === 'comment' && !request.selection) throw new Error('주석을 생성할 코드 범위를 먼저 선택하세요.');
    if (request.kind === 'explain' && !request.symbolId && !request.selection && !this.project.snapshot()) throw new Error('프로젝트를 먼저 여세요.');
    const symbol = request.symbolId ? this.project.getSymbol(request.symbolId) : null;
    if (request.symbolId && !symbol) throw new Error('선택한 심볼을 현재 인덱스에서 찾을 수 없습니다.');

    if ((request.kind === 'explain' || request.kind === 'summary') && symbol) {
      const cached = request.kind === 'summary'
        ? await this.learning.getCachedSymbolSummary(symbol)
        : await this.learning.getCachedExplanation(symbol);
      if (cached) {
        const job: AIJob = { id: crypto.randomUUID(), kind: request.kind, engine: request.engine, model: request.model, state: 'done', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), symbolId: symbol.id, output: cached };
        this.jobs.set(job.id, job); this.emit('created', job); this.emit('updated', job); return job;
      }
    }

    let chatId = request.chatId;
    if (request.kind === 'chat') {
      const chat = await this.learning.appendChat(chatId, 'user', request.question?.trim() || '선택한 코드를 설명해 주세요.', {
        symbolId: request.symbolId,
        selection: request.selection,
      });
      chatId = chat.id;
      request = { ...request, chatId };
    }
    const prompt = await buildPrompt(request, this.project, this.learning);
    return { ...this.enqueue(request, prompt) };
  }

  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || ['done', 'error', 'cancelled'].includes(job.state)) return false;
    const queuedIndex = this.queue.indexOf(id);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.prompts.delete(id);
      this.requests.delete(id);
    }
    const child = this.processes.get(id);
    if (child?.pid) {
      if (process.platform === 'win32') {
        const pid = Number(child.pid);
        if (Number.isSafeInteger(pid) && pid > 0) spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else child.kill('SIGTERM');
    }
    job.state = 'cancelled';
    job.finishedAt = new Date().toISOString();
    this.emit('updated', job);
    if (queuedIndex >= 0) this.catalogProjectHashes.delete(id);
    return true;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const catalogRunning = [...this.jobs.values()].some((job) => job.kind === 'catalog' && job.state === 'running');
      let index = this.queue.findIndex((candidate) => this.requests.get(candidate)?.kind !== 'catalog');
      if (index < 0) {
        if (catalogRunning) return;
        index = 0;
      }
      const [id] = this.queue.splice(index, 1);
      if (!id) return;
      void this.run(id);
    }
  }

  private async completeCatalog(job: AIJob, request: AIRequest): Promise<void> {
    const projectHash = this.catalogProjectHashes.get(job.id);
    if (!projectHash || projectHash !== this.project.semanticSourceHash()) throw new Error('프로젝트 코드가 변경되어 오래된 분석 결과를 폐기했습니다.');
    if (request.catalogMode === 'project-profile') {
      const insight = parseProjectInsightOutput(job.output, projectHash, job.model);
      await this.learning.cacheProjectInsight(insight);
      if (this.backgroundJobs.has(job.id)) this.emitAnalysis({ profileReady: true, message: '프로젝트 목적 분석을 완료했습니다. src 전체 심볼 설명을 계속 준비합니다.' });
      return;
    }
    const requested = (request.symbolIds ?? []).map((id) => this.project.getSymbol(id)).filter((symbol): symbol is SymbolRecord => Boolean(symbol));
    const insights = parseSymbolInsightOutput(job.output, requested, job.model);
    await this.learning.cacheSymbolInsights(insights);
    const missing = Math.max(0, requested.length - insights.length);
    if (this.backgroundJobs.has(job.id)) {
      this.emitAnalysis({
        completed: Math.min(this.analysisStatus.total, this.analysisStatus.completed + insights.length),
        failed: this.analysisStatus.failed + missing,
        message: `${job.analysisFile ?? 'src 파일'} 분석 완료 · ${insights.length.toLocaleString('ko-KR')}개 설명 저장`,
      });
    }
  }

  private finishBackgroundJob(job: AIJob, failed = false): void {
    if (!this.backgroundJobs.has(job.id)) return;
    if (failed && job.batchSize) this.analysisStatus.failed += job.batchSize;
    this.backgroundJobs.delete(job.id);
    if (this.backgroundJobs.size) {
      this.emitAnalysis({
        state: 'running',
        message: failed ? `${job.analysisFile ?? '분석 작업'} 처리 중 오류가 발생했습니다. 나머지 파일은 계속 분석합니다.` : this.analysisStatus.message,
      });
      return;
    }
    const hasError = this.analysisStatus.failed > 0 || !this.analysisStatus.profileReady;
    this.emitAnalysis({
      state: hasError ? 'error' : 'done', currentFile: undefined,
      message: hasError
        ? `사전 분석 종료 · 완료 ${this.analysisStatus.completed.toLocaleString('ko-KR')}개, 실패 ${this.analysisStatus.failed.toLocaleString('ko-KR')}개`
        : `src 전체 심볼 ${this.analysisStatus.completed.toLocaleString('ko-KR')}개의 설명이 준비되었습니다.`,
    });
  }

  private async run(id: string): Promise<void> {
    const job = this.jobs.get(id);
    const request = this.requests.get(id);
    const prompt = this.prompts.get(id);
    const root = this.project.root;
    if (!job || !request || !prompt || !root || job.state === 'cancelled') return;
    this.running += 1;
    job.state = 'running'; job.startedAt = new Date().toISOString(); this.emit('updated', job);
    if (request.kind === 'catalog' && this.backgroundJobs.has(id)) {
      this.emitAnalysis({
        state: 'running', currentFile: request.analysisFile,
        message: request.catalogMode === 'project-profile'
          ? '프로젝트의 실제 목적과 사용자 기능을 분석하고 있습니다.'
          : `${request.analysisFile ?? 'src 파일'}의 심볼 ${request.symbolIds?.length ?? 0}개를 분석하고 있습니다.`,
      });
    }
    const isCancelled = (): boolean => this.jobs.get(id)?.state === 'cancelled';
    let catalogFailed = false;
    try {
      const executable = this.executables.get(request.engine) ?? (await resolveExecutable(request.engine));
      const invocation = buildInvocation(request, root, executable.command);
      invocation.args.unshift(...executable.prefix);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, {
          cwd: invocation.cwd,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        });
        this.processes.set(id, child);
        let stdoutBuffer = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBuffer += chunk.toString('utf8');
          let newline = stdoutBuffer.indexOf('\n');
          while (newline >= 0) {
            const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            const extracted = extractJsonText(request.engine, line);
            if (extracted.text && (extracted.replace || !extracted.final || !job.output)) {
              if (extracted.replace) job.output = extracted.text;
              else job.output += extracted.text;
              this.emit('chunk', job, extracted.text);
            }
            newline = stdoutBuffer.indexOf('\n');
          }
        });
        child.stderr.on('data', (chunk: Buffer) => { stderr = clip(`${stderr}${chunk.toString('utf8')}`, 12_000); });
        child.on('error', reject);
        child.on('close', (code) => {
          if (stdoutBuffer.trim()) {
            const extracted = extractJsonText(request.engine, stdoutBuffer);
            if (extracted.text && (extracted.replace || !extracted.final || !job.output)) {
              if (extracted.replace) job.output = extracted.text;
              else job.output += extracted.text;
              this.emit('chunk', job, extracted.text);
            }
          }
          if (isCancelled()) resolve();
          else if (code === 0 && job.output.trim()) resolve();
          else reject(new Error(stderr.trim() || `${request.engine} CLI가 코드 ${code ?? '알 수 없음'}로 종료되었습니다.`));
        });
        child.stdin.end(prompt, 'utf8');
      });

      if (!isCancelled()) {
        if (request.kind === 'catalog') {
          await this.completeCatalog(job, request);
        } else if ((request.kind === 'explain' || request.kind === 'summary') && request.symbolId) {
          const symbol = this.project.getSymbol(request.symbolId);
          if (symbol) {
            if (request.kind === 'summary') await this.learning.cacheSymbolSummary(symbol, job.output);
            else await this.learning.cacheExplanation(symbol, job.output);
          }
        } else if (request.kind === 'chat' && job.chatId) {
          await this.learning.appendChat(job.chatId, 'assistant', job.output);
        } else if (request.kind === 'quiz' && request.symbolId) {
          const questions = parseQuizMarkdown(job.output);
          if (questions.length !== 3) throw new Error('AI가 이해도 질문 3개를 올바른 JSON으로 반환하지 않았습니다. 다시 시도해 주세요.');
          await this.learning.addQuiz(request.symbolId, questions);
        }
        job.state = 'done'; job.finishedAt = new Date().toISOString(); this.emit('updated', job);
      }
    } catch (error) {
      if (!isCancelled()) {
        catalogFailed = request.kind === 'catalog';
        job.state = 'error'; job.error = (error as Error).message; job.finishedAt = new Date().toISOString(); this.emit('updated', job);
      }
    } finally {
      this.processes.delete(id);
      this.prompts.delete(id);
      this.requests.delete(id);
      this.catalogProjectHashes.delete(id);
      this.running -= 1;
      if (request.kind === 'catalog') this.finishBackgroundJob(job, catalogFailed);
      this.pump();
    }
  }
}
