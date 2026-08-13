import type { CallGraph, GraphNode, ProjectInsight } from '../shared/contracts.js';

export interface FlowStage {
  index: number;
  title: string;
  summary: string;
  nodes: GraphNode[];
  files: string[];
  focus: 'user' | 'platform' | 'mixed';
}

export interface FlowLocation {
  stageIndex: number;
  stageTitle: string;
  node: GraphNode;
}

export interface FlowOverview {
  stages: FlowStage[];
  location: FlowLocation | null;
  unresolvedCount: number;
}

function baseName(file: string): string {
  return file.split('/').at(-1) ?? file;
}

function matches(nodes: GraphNode[], pattern: RegExp): number {
  return nodes.filter((node) => pattern.test(node.name)).length;
}

function isUserNode(node: GraphNode): boolean {
  return /(?:^|\/)src\//i.test(node.file.replaceAll('\\', '/')) && node.origin !== 'rtd' && node.origin !== 'mex';
}

function stageFocus(nodes: GraphNode[]): FlowStage['focus'] {
  const user = nodes.filter(isUserNode).length;
  if (!user) return 'platform';
  return user === nodes.length ? 'user' : 'mixed';
}

function describeStage(index: number, nodes: GraphNode[], isLast: boolean): Pick<FlowStage, 'title' | 'summary'> {
  if (index === 0) {
    const irqCount = nodes.filter((node) => node.kind === 'irq').length;
    return {
      title: irqCount ? '실행 및 이벤트 진입' : '실행 진입',
      summary: irqCount
        ? '프로그램 시작점과 인터럽트 이벤트에서 실행 흐름이 시작됩니다.'
        : '프로그램이 시작되고 상위 작업으로 제어가 전달됩니다.',
    };
  }

  const threshold = Math.max(1, Math.ceil(nodes.length * 0.3));
  if (matches(nodes, /(?:init|config|setup|clock|pin|enable|startup|prepare)/i) >= threshold) {
    return { title: '초기화 및 구성', summary: '실행에 필요한 장치, 설정값과 내부 상태를 준비합니다.' };
  }
  if (matches(nodes, /(?:read|get|receive|sample|acquire|input|poll|status|detect|measure)/i) >= threshold) {
    return { title: '입력 및 상태 수집', summary: '외부 입력이나 현재 장치 상태를 읽어 처리에 필요한 데이터를 모읍니다.' };
  }
  if (matches(nodes, /(?:write|set|send|transmit|output|apply|commit|notify|report)/i) >= threshold) {
    return { title: '출력 및 상태 반영', summary: '처리 결과를 상태 변수, 장치 또는 외부 인터페이스에 반영합니다.' };
  }
  const driverCount = nodes.filter((node) => node.origin === 'rtd' || node.origin === 'mex').length;
  if (driverCount >= threshold) {
    return { title: '드라이버 및 하드웨어 연동', summary: '프로젝트 로직이 생성 코드나 RTD 드라이버를 통해 하드웨어와 연결됩니다.' };
  }
  if (matches(nodes, /(?:run|task|process|handle|check|calculate|compute|update|execute|service|diag)/i) >= threshold) {
    return { title: '핵심 처리', summary: '수집된 값과 현재 상태를 이용해 프로젝트의 주요 판단과 계산을 수행합니다.' };
  }
  if (index === 1) return { title: '주요 작업 진입', summary: '시작 지점에서 프로젝트의 주요 기능 단위로 실행이 분기됩니다.' };
  if (isLast) return { title: '후속 처리', summary: '앞 단계의 결과를 보조 로직과 하위 모듈에서 마무리합니다.' };
  return { title: '기능 처리', summary: '앞 단계에서 전달된 제어와 데이터를 하위 기능에서 처리합니다.' };
}

export function buildFlowOverview(graph: CallGraph, focusId?: string, insight?: ProjectInsight | null): FlowOverview {
  const internalNodes = graph.nodes.filter((node) => node.kind !== 'external');
  const nodeById = new Map(internalNodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map(internalNodes.map((node) => [node.id, 0]));

  for (const edge of graph.edges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  let roots = graph.roots.filter((id) => nodeById.has(id));
  if (!roots.length) roots = internalNodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  if (!roots.length && internalNodes[0]) roots = [internalNodes[0].id];

  const depth = new Map<string, number>();
  const queue = roots.map((id) => ({ id, depth: 0 }));
  while (queue.length) {
    const current = queue.shift()!;
    const previous = depth.get(current.id);
    if (previous !== undefined && previous <= current.depth) continue;
    depth.set(current.id, current.depth);
    if (current.depth >= 12) continue;
    for (const next of outgoing.get(current.id) ?? []) queue.push({ id: next, depth: current.depth + 1 });
  }

  for (const node of internalNodes) if (!depth.has(node.id)) depth.set(node.id, 1);
  const grouped = new Map<number, GraphNode[]>();
  for (const node of internalNodes) {
    const displayDepth = Math.min(depth.get(node.id) ?? 1, 4);
    const nodes = grouped.get(displayDepth) ?? [];
    nodes.push(node);
    grouped.set(displayDepth, nodes);
  }

  const groups = [...grouped.entries()].sort(([a], [b]) => a - b);
  let stages = groups.map(([, nodes], index): FlowStage => {
    nodes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name));
    const description = describeStage(index, nodes, index === groups.length - 1);
    return {
      index,
      ...description,
      nodes,
      files: [...new Set(nodes.map((node) => node.file).filter(Boolean))],
      focus: stageFocus(nodes),
    };
  });

  if (insight?.stages.length) {
    const orderedNodes = stages.flatMap((stage) => stage.nodes);
    const stageCount = insight.stages.length;
    const buckets = Array.from({ length: stageCount }, () => [] as GraphNode[]);
    orderedNodes.forEach((node, index) => {
      const bucket = Math.min(stageCount - 1, Math.floor(index * stageCount / Math.max(1, orderedNodes.length)));
      buckets[bucket]!.push(node);
    });
    stages = insight.stages.map((semantic, index) => {
      const nodes = buckets[index]!.sort((a, b) => Number(isUserNode(b)) - Number(isUserNode(a)) || a.file.localeCompare(b.file) || a.line - b.line);
      return {
        index,
        title: semantic.title,
        summary: semantic.summary,
        focus: semantic.focus,
        nodes,
        files: [...new Set(nodes.map((node) => node.file).filter(Boolean))],
      };
    });
  }

  let location: FlowLocation | null = null;
  if (focusId) {
    const stage = stages.find((candidate) => candidate.nodes.some((node) => node.id === focusId));
    const node = stage?.nodes.find((candidate) => candidate.id === focusId);
    if (stage && node) location = { stageIndex: stage.index, stageTitle: stage.title, node };
  }

  return {
    stages,
    location,
    unresolvedCount: graph.nodes.filter((node) => node.kind === 'external').length,
  };
}

function text<K extends keyof HTMLElementTagNameMap>(tag: K, value: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

export function renderFlowOverview(
  container: HTMLElement,
  graph: CallGraph,
  focusId: string | undefined,
  onNode: (id: string) => void,
  insight?: ProjectInsight | null,
): { reset: () => void; location: FlowLocation | null } {
  container.replaceChildren();
  const overview = buildFlowOverview(graph, focusId, insight);
  if (!overview.stages.length) {
    container.append(text('p', '표시할 실행 흐름이 없습니다.', 'empty'));
    return { reset: () => undefined, location: null };
  }

  const intro = document.createElement('header');
  intro.className = 'flow-intro';
  intro.append(
    text('h2', insight?.purpose ?? '프로그램 실행 순서'),
    text('p', insight
      ? 'src의 사용자 기능을 중심으로 목적 달성 과정을 요약했습니다. 플랫폼 코드는 보조 계층으로 구분합니다.'
      : '목적 분석을 준비하는 동안 정적 호출 순서로 표시합니다. 세부 호출은 접어 두었습니다.'),
  );
  const legend = document.createElement('div'); legend.className = 'flow-legend';
  legend.append(text('span', 'SRC · 사용자 동작', 'user'), text('span', 'PLATFORM · RTD/MEX/SDK', 'platform'));
  intro.append(legend);
  if (insight?.stale) intro.append(text('span', '이전 코드 기준 개요 · 현재 코드와 다를 수 있음', 'flow-stale'));
  if (overview.unresolvedCount) {
    intro.append(text('span', `정의를 찾지 못한 외부 호출 ${overview.unresolvedCount}개는 개요에서 제외`, 'flow-omitted'));
  }

  const list = document.createElement('ol');
  list.className = 'flow-steps';
  for (const stage of overview.stages) {
    const current = overview.location?.stageIndex === stage.index;
    const item = document.createElement('li');
    item.className = `flow-stage ${stage.focus}-focused${current ? ' current' : ''}`;
    item.dataset.stage = String(stage.index);

    const marker = text('span', String(stage.index + 1).padStart(2, '0'), 'flow-step-number');
    const card = document.createElement('article');
    const heading = document.createElement('header');
    const headingText = document.createElement('div');
    headingText.append(text('h3', stage.title), text('span', `${stage.nodes.length}개 함수`, 'flow-count'));
    heading.append(headingText);
    card.append(heading, text('p', stage.summary, 'flow-stage-summary'));

    const modules = document.createElement('div');
    modules.className = 'flow-modules';
    for (const file of stage.files.slice(0, 3)) modules.append(text('span', baseName(file), /(?:^|\/)src\//i.test(file) ? 'user-code' : 'platform-code'));
    if (stage.files.length > 3) modules.append(text('span', `외 ${stage.files.length - 3}개 모듈`));
    card.append(modules);

    const keyNodes = stage.nodes.filter(isUserNode).slice(0, 3);
    if (keyNodes.length) {
      const keyArea = document.createElement('div'); keyArea.className = 'flow-key-actions';
      keyArea.append(text('small', '대표 사용자 코드'));
      const actions = document.createElement('div');
      for (const node of keyNodes) {
        const button = document.createElement('button'); button.className = `flow-key-action${node.id === focusId ? ' selected' : ''}`;
        button.append(text('code', node.name), text('small', `${node.file}:${node.line}`));
        button.addEventListener('click', () => onNode(node.id)); actions.append(button);
      }
      keyArea.append(actions); card.append(keyArea);
    }

    if (current && overview.location) {
      const location = document.createElement('button');
      location.className = 'flow-current-symbol';
      const label = document.createElement('span');
      label.append(text('small', '현재 선택'), text('strong', overview.location.node.name));
      const source = text('code', `${overview.location.node.file}:${overview.location.node.line}`);
      location.append(label, source);
      location.addEventListener('click', () => onNode(overview.location!.node.id));
      card.append(location);
    }

    const details = document.createElement('details');
    details.className = 'flow-functions';
    const summary = document.createElement('summary');
    summary.textContent = `포함된 코드 보기 (${stage.nodes.length})`;
    details.append(summary);
    const functions = document.createElement('div');
    for (const node of stage.nodes) {
      const button = document.createElement('button');
      button.className = `flow-function ${isUserNode(node) ? 'user-code' : 'platform-code'}${node.id === focusId ? ' selected' : ''}`;
      const label = document.createElement('span');
      label.append(text('b', isUserNode(node) ? 'SRC' : node.origin === 'rtd' ? 'RTD' : node.origin === 'mex' ? 'MEX' : 'PLATFORM'), text('code', node.name));
      button.append(label, text('small', `${node.file}:${node.line}`));
      button.addEventListener('click', () => onNode(node.id));
      functions.append(button);
    }
    details.append(functions);
    card.append(details);
    item.append(marker, card);
    list.append(item);
  }

  container.append(intro, list);
  const reset = (): void => { container.scrollTo({ top: 0, behavior: 'smooth' }); };
  if (overview.location) {
    requestAnimationFrame(() => container.querySelector<HTMLElement>('.flow-stage.current')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }
  return { reset, location: overview.location };
}
