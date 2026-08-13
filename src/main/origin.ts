import type { OriginEvidence, OriginKind, SourceRange } from '../shared/contracts.js';

export interface MexInventory {
  files: string[];
  components: string[];
}

function lineAnchor(file: string, line: number): SourceRange {
  return { file, startLine: line, startColumn: 1, endLine: line, endColumn: 1 };
}

function matchingLine(source: string, pattern: RegExp): number | null {
  const lines = source.split(/\r?\n/).slice(0, 60);
  const index = lines.findIndex((line) => pattern.test(line));
  return index < 0 ? null : index + 1;
}

export function parseMexInventory(files: Array<{ path: string; source: string }>): MexInventory {
  const components = new Set<string>();
  for (const { source } of files) {
    const patterns = [
      /<(?:instance|component)\b[^>]*(?:name|type)=["']([^"']+)["']/gi,
      /<setting\b[^>]*name=["'](?:Name|name)["'][^>]*value=["']([^"']+)["']/gi,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) if (match[1]) components.add(match[1]);
    }
  }
  return { files: files.map((file) => file.path), components: [...components].sort() };
}

export function classifyOrigin(
  file: string,
  source: string,
  mex: MexInventory,
  aiConfirmedFiles: Set<string> = new Set(),
): OriginEvidence {
  const normalized = file.replaceAll('\\', '/');
  const lower = normalized.toLocaleLowerCase('en-US');
  const userManagedPath = /^src\//.test(lower);
  const generatedPath = /(^|\/)(generate(?:d|_code)?|codegen|gen)(\/|$)/.test(lower);
  const generatedLine = matchingLine(source, /(auto[- ]?generated|generated (?:code|file)|do not edit|s32 configuration tools|mex)/i);
  const matchedComponent = mex.components.find((name) => lower.includes(name.toLocaleLowerCase('en-US')) || source.slice(0, 5000).includes(name));

  if (generatedPath || generatedLine !== null) {
    const anchors = generatedLine ? [lineAnchor(file, generatedLine)] : [lineAnchor(file, 1)];
    const details = [generatedPath ? '생성 코드 경로' : '', generatedLine ? '생성 주석' : '', matchedComponent ? `.mex 구성요소 ${matchedComponent}` : '']
      .filter(Boolean)
      .join(', ');
    return {
      kind: 'mex',
      label: 'MEX 생성 코드',
      confidence: generatedPath && generatedLine ? 'confirmed' : 'strong',
      rule: details || '생성 코드 규칙과 일치',
      anchors,
    };
  }

  const vendorPath = /(^|\/)(rtd|mcal|platform\/drivers|sdk)(\/|$)/.test(lower);
  const nxpLine = matchingLine(source, /(nxp semiconductors|copyright.*nxp|real[- ]?time drivers|autosar)/i);
  // A copyright line in a top-level src file is often inherited from an NXP
  // example and does not make every application symbol an RTD implementation.
  if (vendorPath || (nxpLine !== null && !userManagedPath)) {
    return {
      kind: 'rtd',
      label: 'RTD/SDK 공급 코드',
      confidence: vendorPath && nxpLine ? 'confirmed' : 'strong',
      rule: [vendorPath ? 'RTD·MCAL·SDK 경로' : '', nxpLine ? 'NXP/RTD 저작권 또는 제품 주석' : ''].filter(Boolean).join(', '),
      anchors: [lineAnchor(file, nxpLine ?? 1)],
    };
  }

  if (aiConfirmedFiles.has(normalized)) {
    return {
      kind: 'ai-confirmed',
      label: 'AI 작성 확인됨',
      confidence: 'confirmed',
      rule: 'Auto CodeTutor가 신뢰 가능한 작업 기록에서 확인',
      anchors: [lineAnchor(file, 1)],
    };
  }

  return {
    kind: 'unknown',
    label: userManagedPath ? '사용자 관리 코드' : '프로젝트 코드 · 출처 미확인',
    confidence: 'limited',
    rule: userManagedPath
      ? 'src 코드이며 MEX·RTD 생성 근거가 없음. 작성 주체는 작업 기록 없이는 확정할 수 없음'
      : 'MEX·RTD 근거 또는 신뢰 가능한 AI 작업 기록이 없음',
    anchors: [lineAnchor(file, 1)],
  };
}

export function originLabel(kind: OriginKind): string {
  return ({ mex: 'MEX', rtd: 'RTD/SDK', 'ai-confirmed': 'AI 확인', unknown: '작성자 불명' })[kind];
}
