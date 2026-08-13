const INTEGER_TYPES: Record<string, { bits: number; signed: boolean }> = {
  int8_t: { bits: 8, signed: true }, uint8_t: { bits: 8, signed: false },
  int16_t: { bits: 16, signed: true }, uint16_t: { bits: 16, signed: false },
  int32_t: { bits: 32, signed: true }, uint32_t: { bits: 32, signed: false },
  int64_t: { bits: 64, signed: true }, uint64_t: { bits: 64, signed: false },
};

function integerRange(bits: number, signed: boolean): string {
  if (!signed) return bits === 64 ? '0 이상 18,446,744,073,709,551,615 이하' : `0 이상 ${(2 ** bits - 1).toLocaleString('en-US')} 이하`;
  if (bits === 64) return '-9,223,372,036,854,775,808 이상 9,223,372,036,854,775,807 이하';
  return `${(-(2 ** (bits - 1))).toLocaleString('en-US')} 이상 ${(2 ** (bits - 1) - 1).toLocaleString('en-US')} 이하`;
}

/** A deterministic first explanation while project-specific AI semantics are loading. */
export function describeCType(rawType: string): string {
  const compact = rawType.replace(/\s+/g, ' ').trim();
  if (!compact) return '타입 정보가 없습니다.';
  if (/매크로/.test(compact)) return '컴파일 전에 값이나 코드로 치환되는 전처리기 매크로입니다.';

  const isConst = /\bconst\b/.test(compact);
  const isVolatile = /\bvolatile\b/.test(compact);
  const pointerDepth = (compact.match(/\*/g) ?? []).length;
  const array = compact.match(/\[([^\]]*)\]/)?.[1];
  const base = compact
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\*/g, '')
    .replace(/\b(?:const|volatile|static|extern|register)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  let description: string;
  const integer = INTEGER_TYPES[base];
  if (integer) {
    description = `${integer.bits}비트 ${integer.signed ? '부호 있는' : '부호 없는'} 정수이며 값 범위는 ${integerRange(integer.bits, integer.signed)}입니다.`;
  } else if (base === 'bool' || base === '_Bool') {
    description = '참(true) 또는 거짓(false)을 나타내는 논리 타입입니다.';
  } else if (base === 'char' || base === 'signed char' || base === 'unsigned char') {
    description = '한 바이트 문자 또는 작은 정수 데이터를 보관하는 타입입니다.';
  } else if (base === 'float') {
    description = '일반적으로 32비트 단정밀도 부동소수점 값입니다.';
  } else if (base === 'double') {
    description = '일반적으로 64비트 배정밀도 부동소수점 값입니다.';
  } else if (base === 'void') {
    description = pointerDepth ? '구체적인 데이터 타입이 정해지지 않은 메모리 주소를 전달하는 범용 포인터입니다.' : '값 또는 반환값이 없음을 뜻합니다.';
  } else if (base === 'size_t') {
    description = '메모리 크기와 배열 길이를 표현하는 부호 없는 정수 타입이며 폭은 대상 플랫폼에 따라 달라집니다.';
  } else if (base === 'status_t') {
    description = 'NXP SDK 계열 API의 성공·실패 상태 코드를 전달하는 타입입니다. 실제 값은 STATUS_SUCCESS 등의 상수로 해석합니다.';
  } else if (base === 'err_t') {
    description = 'lwIP API의 성공 또는 네트워크 오류 코드를 전달하는 상태 타입입니다.';
  } else if (base === 'TickType_t') {
    description = 'FreeRTOS의 시스템 틱 수와 시간 간격을 표현하는 정수 타입입니다.';
  } else if (/^struct\b/.test(base)) {
    description = `${base.replace(/^struct\s+/, '') || '익명'} 구조체의 여러 필드를 하나로 묶은 타입입니다.`;
  } else if (/^union\b/.test(base)) {
    description = `${base.replace(/^union\s+/, '') || '익명'} 공용체의 멤버가 같은 메모리를 공유하는 타입입니다.`;
  } else if (/^enum\b/.test(base)) {
    description = `${base.replace(/^enum\s+/, '') || '익명'} 열거형에 정의된 상태 또는 선택지를 표현합니다.`;
  } else if (/_t$/.test(base)) {
    description = `${base}는 프로젝트·라이브러리·SDK에서 정의한 타입 별칭입니다. 정확한 값 범위와 의미는 정의 및 사용 문맥으로 결정됩니다.`;
  } else if (/\b(?:unsigned|signed|short|long|int)\b/.test(base)) {
    description = `${base} 정수 타입입니다. 정확한 비트 폭은 컴파일러와 대상 아키텍처 설정에 따라 달라집니다.`;
  } else {
    description = `${base}는 프로젝트 또는 외부 SDK에서 정의한 사용자 타입입니다.`;
  }

  const details: string[] = [];
  if (pointerDepth && base !== 'void') details.push(`${pointerDepth > 1 ? `${pointerDepth}단계 ` : ''}포인터이므로 값 자체가 아니라 대상의 메모리 주소를 보관합니다.`);
  if (array !== undefined) details.push(array.trim() ? `${array.trim()}개 요소를 갖는 배열입니다.` : '길이가 선언 문맥에서 결정되는 배열입니다.');
  if (isConst) details.push('const 한정자로 이 경로에서는 값을 변경하지 않습니다.');
  if (isVolatile) details.push('volatile 한정자로 인터럽트나 하드웨어 등 코드 밖의 요인에 의해 값이 바뀔 수 있습니다.');
  return [description, ...details].join(' ');
}
