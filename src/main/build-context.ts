import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BuildConfiguration, BuildContextInfo } from '../shared/contracts.js';

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attribute(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function optionValues(body: string, valueType: 'definedSymbols' | 'includePath'): string[] {
  const values: string[] = [];
  // Put the self-closing alternative first. CDT emits many `<option .../>`
  // elements; treating one as an opening tag would consume the next unrelated
  // `</option>` and hide the compiler include/define options that follow it.
  const optionPattern = /<option\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/option>)/gi;
  for (const match of body.matchAll(optionPattern)) {
    const attrs = match[1] ?? '';
    if (attribute(attrs, 'valueType') !== valueType) continue;
    const optionBody = match[2] ?? '';
    for (const item of optionBody.matchAll(/<listOptionValue\b([^>]*)\/?\s*>/gi)) {
      const value = attribute(item[1] ?? '', 'value');
      if (value) values.push(value);
    }
    const direct = attribute(attrs, 'value');
    if (direct) values.push(...direct.split(/[;,]/));
  }
  return unique(values);
}

export function parseCProject(xml: string): BuildConfiguration[] {
  const configurations: BuildConfiguration[] = [];
  const pattern = /<cconfiguration\b([^>]*)>([\s\S]*?)<\/cconfiguration>/gi;
  for (const match of xml.matchAll(pattern)) {
    const outerAttrs = match[1] ?? '';
    const body = match[2] ?? '';
    const configurationTag = body.match(/<configuration\b([^>]*)>/i)?.[1] ?? '';
    const id = attribute(outerAttrs, 'id') ?? attribute(configurationTag, 'id') ?? `configuration-${configurations.length + 1}`;
    const name = attribute(configurationTag, 'name') ?? id;
    const toolchainTag = body.match(/<toolChain\b([^>]*)>/i)?.[1] ?? '';
    const builderTag = body.match(/<builder\b([^>]*)>/i)?.[1] ?? '';
    const configuration: BuildConfiguration = {
      id,
      name,
      defines: optionValues(body, 'definedSymbols'),
      includePaths: optionValues(body, 'includePath'),
    };
    const toolchain = attribute(toolchainTag, 'name');
    const buildPath = attribute(builderTag, 'buildPath');
    if (toolchain) configuration.toolchain = toolchain;
    if (buildPath) configuration.buildPath = buildPath;
    configurations.push(configuration);
  }
  return configurations;
}

export async function loadBuildContext(root: string, enabled: boolean, preferredId?: string): Promise<BuildContextInfo> {
  const cproject = path.join(root, '.cproject');
  let configurations: BuildConfiguration[] = [];
  try {
    configurations = parseCProject(await readFile(cproject, 'utf8'));
  } catch {
    return {
      enabled,
      available: false,
      configurations: [],
      note: '이 프로젝트에서 Eclipse CDT/S32DS .cproject 빌드 설정을 찾지 못했습니다.',
    };
  }
  const active = configurations.find((configuration) => configuration.id === preferredId) ?? configurations[0];
  return {
    enabled,
    available: configurations.length > 0,
    source: '.cproject',
    activeConfigurationId: active?.id,
    configurations,
    note: enabled
      ? '선택한 빌드 구성의 define·include 경로를 AI 분석 문맥에 반영합니다. 전처리기와 컴파일러를 완전히 재현하지는 않습니다.'
      : '메뉴의 분석 항목에서 빌드 설정 인식(실험적)을 켤 수 있습니다.',
  };
}
