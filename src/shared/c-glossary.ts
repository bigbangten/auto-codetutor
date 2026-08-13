export interface CTokenExplanation {
  token: string;
  title: string;
  category: string;
  summary: string;
  details: string[];
  example?: string;
  context?: string;
}

type Entry = Omit<CTokenExplanation, 'token' | 'context'>;

const entries: Record<string, Entry> = {
  include: {
    title: '#include · 헤더 포함', category: '전처리 지시문',
    summary: '컴파일 전에 다른 헤더 파일의 선언과 매크로를 현재 파일에서 사용할 수 있게 가져옵니다.',
    details: ['<...>는 보통 컴파일러·SDK의 include 경로에서 찾고, "..."는 현재 파일 주변을 먼저 찾습니다.', '함수 구현을 복사하는 동작이 아니라 함수 원형, 타입, 매크로 같은 선언을 보이게 하는 단계입니다.'],
    example: '#include <stdint.h>',
  },
  define: {
    title: '#define · 매크로 정의', category: '전처리 지시문',
    summary: '컴파일 전에 이름을 값이나 코드 조각으로 치환하도록 정의합니다.',
    details: ['상수처럼 보이는 매크로와 인자를 받는 함수형 매크로가 있습니다.', '타입 검사 없이 텍스트가 확장되므로 괄호와 부작용을 주의해야 합니다.'],
    example: '#define UDP_PORT 5004U',
  },
  ifdef: { title: '#ifdef · 조건부 컴파일', category: '전처리 지시문', summary: '지정한 매크로가 정의되어 있을 때만 아래 코드를 컴파일합니다.', details: ['보드 종류, 기능 옵션, 디버그 빌드에 따라 코드를 선택할 때 사용합니다.'] },
  ifndef: { title: '#ifndef · 미정의 조건', category: '전처리 지시문', summary: '지정한 매크로가 정의되어 있지 않을 때만 아래 코드를 컴파일합니다.', details: ['헤더가 여러 번 포함되는 것을 막는 include guard에 흔히 사용됩니다.'] },
  endif: { title: '#endif · 조건부 컴파일 종료', category: '전처리 지시문', summary: '#if, #ifdef, #ifndef로 시작한 조건부 컴파일 구간을 끝냅니다.', details: ['중첩된 조건이 많다면 옆 주석으로 어떤 조건을 닫는지 표시하면 읽기 쉽습니다.'] },
  elif: { title: '#elif · 추가 컴파일 조건', category: '전처리 지시문', summary: '앞선 #if 조건이 거짓일 때 다른 전처리 조건을 검사합니다.', details: ['일반 C의 else if가 아니라 컴파일할 코드 자체를 고르는 전처리 단계입니다.'] },
  pragma: { title: '#pragma · 컴파일러 지시', category: '전처리 지시문', summary: '정렬, 경고, 섹션 배치 등 컴파일러별 동작을 지정합니다.', details: ['지원 내용은 컴파일러마다 다르므로 프로젝트의 툴체인 문서를 함께 확인해야 합니다.'] },
  undef: { title: '#undef · 매크로 해제', category: '전처리 지시문', summary: '앞서 정의된 매크로를 이후 코드에서 정의되지 않은 상태로 되돌립니다.', details: ['같은 이름을 다른 의미로 다시 정의하기 전에 사용하기도 합니다.'] },
  volatile: {
    title: 'volatile · 외부 변경 가능 한정자', category: '타입 한정자',
    summary: '값이 현재 코드 흐름 밖에서 바뀔 수 있으므로 매 접근마다 실제 메모리를 읽고 쓰도록 컴파일러에 알립니다.',
    details: ['메모리 맵 레지스터, 인터럽트와 공유하는 플래그, 하드웨어가 갱신하는 값에 주로 사용합니다.', '원자성이나 스레드 동기화를 보장하지는 않습니다. 여러 태스크가 공유한다면 별도의 동기화가 필요합니다.'],
    example: 'volatile uint32_t status;',
  },
  const: { title: 'const · 변경 제한 한정자', category: '타입 한정자', summary: '이 이름을 통해서는 대상 값을 수정하지 않겠다는 제약을 컴파일러에 줍니다.', details: ['포인터에서는 const가 포인터 자체에 붙는지, 가리키는 값에 붙는지 위치를 함께 읽어야 합니다.'] },
  restrict: { title: 'restrict · 단독 접근 포인터', category: '타입 한정자', summary: '해당 포인터가 가리키는 객체에 주로 이 포인터를 통해 접근한다고 약속해 최적화를 돕습니다.', details: ['약속을 어기면 동작이 정의되지 않을 수 있어 사용 조건을 정확히 확인해야 합니다.'] },
  static: { title: 'static · 저장 기간/가시성 지정', category: '저장 클래스', summary: '파일 범위에서는 외부 파일에 숨기고, 함수 내부에서는 호출이 끝나도 값을 유지하게 합니다.', details: ['함수 앞의 static은 이 파일 전용 함수라는 뜻입니다.', '지역 변수 앞의 static은 프로그램 전체 실행 동안 저장 공간을 유지한다는 뜻입니다.'] },
  extern: { title: 'extern · 외부 정의 선언', category: '저장 클래스', summary: '실제 저장 공간이나 함수 구현이 다른 위치에 있음을 선언합니다.', details: ['선언만 제공하며 보통 링크 단계에서 다른 C 파일의 정의와 연결됩니다.'] },
  typedef: { title: 'typedef · 타입 별칭', category: '타입 선언', summary: '기존 타입 조합에 읽기 쉬운 새 이름을 붙입니다.', details: ['새로운 런타임 타입을 만드는 것이 아니라 컴파일러가 같은 타입으로 취급하는 별칭입니다.'] },
  struct: { title: 'struct · 구조체', category: '복합 타입', summary: '서로 다른 타입의 필드를 하나의 데이터 묶음으로 저장합니다.', details: ['각 필드는 별도 저장 공간을 가지며 선언 순서와 정렬 규칙에 따라 전체 크기가 결정됩니다.'] },
  union: { title: 'union · 공용체', category: '복합 타입', summary: '여러 필드가 같은 메모리 공간을 공유하도록 정의합니다.', details: ['한 시점에 어떤 필드가 유효한지 코드의 상태나 별도 태그로 판단해야 합니다.'] },
  enum: { title: 'enum · 열거형', category: '복합 타입', summary: '서로 관련된 정수 상수에 의미 있는 이름을 붙인 타입입니다.', details: ['상태, 모드, 오류 종류처럼 가능한 값의 집합을 표현할 때 유용합니다.'] },
  inline: { title: 'inline · 인라인 힌트', category: '함수 지정자', summary: '함수 호출 대신 본문을 펼치는 최적화를 허용하거나 제안합니다.', details: ['실제 인라인 여부는 컴파일러가 결정하며 C의 링크 규칙도 함께 영향을 줍니다.'] },
  sizeof: { title: 'sizeof · 저장 크기 계산', category: '연산자', summary: '타입이나 객체가 차지하는 바이트 수를 컴파일 시점 중심으로 계산합니다.', details: ['배열 자체에는 전체 크기를 주지만 함수 인자로 전달된 배열은 포인터 크기만 보일 수 있습니다.'] },
  return: { title: 'return · 함수 종료/반환', category: '제어문', summary: '현재 함수를 즉시 끝내고 호출자에게 값 또는 제어를 돌려줍니다.', details: ['void 함수는 값 없이 return할 수 있고, 다른 함수는 선언된 반환 타입과 맞는 값을 제공해야 합니다.'] },
  if: { title: 'if · 조건 분기', category: '제어문', summary: '조건식이 0이 아닐 때 연결된 코드 블록을 실행합니다.', details: ['조건식 안의 대입(=)과 비교(==)를 혼동하지 않도록 주의합니다.'] },
  else: { title: 'else · 대체 분기', category: '제어문', summary: '바로 앞 if 조건이 거짓일 때 실행할 경로를 지정합니다.', details: ['else if를 이어 여러 조건을 순서대로 검사할 수 있습니다.'] },
  switch: { title: 'switch · 값 기반 분기', category: '제어문', summary: '정수형 표현식의 값에 맞는 case 지점으로 실행을 이동합니다.', details: ['break가 없으면 다음 case로 계속 실행되는 fall-through가 발생합니다.'] },
  case: { title: 'case · switch 분기값', category: '제어문', summary: 'switch 표현식과 일치할 때 시작할 실행 위치를 표시합니다.', details: ['case 값은 컴파일 시점에 결정 가능한 정수 상수여야 합니다.'] },
  default: { title: 'default · 기본 분기', category: '제어문', summary: '어떤 case와도 일치하지 않을 때 실행할 switch 경로입니다.', details: ['예상하지 못한 상태를 처리하거나 오류를 기록하는 데 유용합니다.'] },
  for: { title: 'for · 반복문', category: '제어문', summary: '초기화, 반복 조건, 증감식을 한곳에 모아 코드를 반복합니다.', details: ['조건이 거짓이 되면 종료하며 각 항목은 필요에 따라 생략할 수 있습니다.'] },
  while: { title: 'while · 조건 반복', category: '제어문', summary: '매 반복 전에 조건을 검사하고 참인 동안 코드를 반복합니다.', details: ['조건을 바꾸는 경로가 없으면 의도치 않은 무한 반복이 될 수 있습니다.'] },
  do: { title: 'do-while · 후조건 반복', category: '제어문', summary: '본문을 최소 한 번 실행한 뒤 조건을 검사해 반복합니다.', details: ['입력 재시도처럼 첫 실행이 반드시 필요한 흐름에 사용합니다.'] },
  break: { title: 'break · 반복/분기 탈출', category: '제어문', summary: '가장 가까운 loop 또는 switch를 즉시 빠져나갑니다.', details: ['중첩 구조에서는 현재 포함된 가장 안쪽 구조만 종료합니다.'] },
  continue: { title: 'continue · 다음 반복', category: '제어문', summary: '현재 반복의 남은 문장을 건너뛰고 다음 반복 조건으로 이동합니다.', details: ['for에서는 증감식을 수행한 뒤 조건을 다시 검사합니다.'] },
  void: { title: 'void · 값 없음/불특정 객체', category: '기본 타입', summary: '함수 반환값이 없거나 포인터가 특정 객체 타입에 아직 묶이지 않았음을 표현합니다.', details: ['void *는 객체 포인터를 범용적으로 담지만 사용 전에 올바른 타입으로 해석해야 합니다.'] },
  char: { title: 'char · 문자 단위 정수형', category: '기본 타입', summary: 'C에서 가장 작은 주소 지정 단위의 정수 타입이며 문자와 원시 바이트 표현에 사용합니다.', details: ['signed 여부는 컴파일러 설정에 따라 달라질 수 있어 범위가 중요하면 int8_t/uint8_t를 고려합니다.'] },
  int: { title: 'int · 기본 정수형', category: '기본 타입', summary: '대상 CPU에서 자연스럽게 처리하도록 정한 부호 있는 정수 타입입니다.', details: ['정확한 비트 수가 필요하면 stdint.h의 int32_t 같은 고정 폭 타입을 사용합니다.'] },
  unsigned: { title: 'unsigned · 부호 없는 정수', category: '타입 지정자', summary: '음수 없이 0부터 양수 범위를 사용하는 정수 타입으로 지정합니다.', details: ['오버플로는 2의 비트 폭을 기준으로 순환하지만 signed/unsigned 혼합 비교는 주의해야 합니다.'] },
  signed: { title: 'signed · 부호 있는 정수', category: '타입 지정자', summary: '음수와 양수를 표현하는 정수 타입으로 명시합니다.', details: ['생략한 int는 일반적으로 signed int와 같은 의미입니다.'] },
  float: { title: 'float · 단정밀도 실수', category: '기본 타입', summary: '소수와 큰 범위의 값을 근사해 표현하는 부동소수점 타입입니다.', details: ['정확한 소수 비교와 누적 오차에 주의해야 합니다.'] },
  double: { title: 'double · 배정밀도 실수', category: '기본 타입', summary: 'float보다 일반적으로 더 넓은 정밀도와 범위를 제공하는 부동소수점 타입입니다.', details: ['임베디드 타깃에서는 성능과 라이브러리 비용을 확인해야 합니다.'] },
  bool: { title: 'bool · 논리값 타입', category: '기본 타입', summary: '참(true)과 거짓(false)을 표현하는 논리 타입입니다.', details: ['C에서는 보통 stdbool.h가 _Bool의 별칭과 true/false 매크로를 제공합니다.'] },
  short: { title: 'short · 짧은 정수형', category: '기본 타입', summary: 'int보다 작거나 같은 저장 폭을 갖도록 지정하는 정수 타입입니다.', details: ['정확한 폭이 필요하면 int16_t 같은 고정 폭 타입을 사용합니다.'] },
  long: { title: 'long · 확장 정수/실수 지정자', category: '기본 타입', summary: 'long int의 정수 범위를 넓히거나 long double의 실수 정밀도를 지정합니다.', details: ['실제 비트 폭은 플랫폼 ABI에 따라 달라질 수 있습니다.'] },
  auto: { title: 'auto · 자동 저장 기간', category: '저장 클래스', summary: '블록에 들어올 때 만들어지고 벗어날 때 수명이 끝나는 일반 지역 변수임을 명시합니다.', details: ['C 지역 변수의 기본값이라 실무 코드에서는 거의 생략합니다.'] },
  register: { title: 'register · 빠른 접근 힌트', category: '저장 클래스', summary: '변수를 빠르게 접근할 수 있는 위치에 두도록 컴파일러에 힌트를 줍니다.', details: ['현대 컴파일러는 보통 자체 최적화하며 이 지정자는 주소 취득을 제한할 수 있습니다.'] },
  goto: { title: 'goto · 레이블 이동', category: '제어문', summary: '같은 함수 안의 지정한 레이블로 제어를 이동합니다.', details: ['임베디드 C에서는 여러 자원 정리 경로를 하나로 모을 때 제한적으로 사용하기도 합니다.'] },
  true: { title: 'true · 논리 참', category: '논리 상수', summary: '조건이 참임을 나타내는 bool 값입니다.', details: ['C에서는 stdbool.h가 제공하는 매크로이며 조건식에서 0이 아닌 값으로 동작합니다.'] },
  false: { title: 'false · 논리 거짓', category: '논리 상수', summary: '조건이 거짓임을 나타내는 bool 값입니다.', details: ['C 조건식에서 0은 거짓으로 평가됩니다.'] },
  _Atomic: { title: '_Atomic · 원자적 접근 타입', category: '타입 한정자', summary: '다른 실행 흐름과 공유할 때 중간 상태 없이 읽고 쓰도록 원자 타입을 선언합니다.', details: ['메모리 순서와 복합 동기화 요구에는 stdatomic.h의 연산을 함께 사용해야 합니다.'] },
  NULL: { title: 'NULL · 널 포인터 상수', category: '공통 매크로', summary: '유효한 객체나 함수를 가리키지 않는 포인터 상태를 표현합니다.', details: ['포인터를 역참조하기 전에 NULL인지 확인해야 하며 숫자 0이라는 업무 값과 의미를 구분합니다.'] },
};

// These words are part of the C language itself, not project symbols. Keeping the
// list separate from the broader glossary matters because entries such as NULL or
// uint32_t may still have a real declaration in an included header.
const C_RESERVED_WORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
  'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
  'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
  '_Alignas', '_Alignof', '_Atomic', '_Bool', '_Complex', '_Generic', '_Imaginary',
  '_Noreturn', '_Static_assert', '_Thread_local',
]);

export function isCReservedWord(token: string): boolean {
  return C_RESERVED_WORDS.has(token.trim());
}

const operators: Record<string, Entry> = {
  '->': { title: '-> · 포인터 멤버 접근', category: '연산자', summary: '구조체나 공용체를 가리키는 포인터에서 멤버를 선택합니다.', details: ['ptr->field는 (*ptr).field와 같은 의미입니다.'] },
  '.': { title: '. · 멤버 접근', category: '연산자', summary: '구조체나 공용체 객체의 멤버를 선택합니다.', details: ['왼쪽이 포인터라면 . 대신 ->를 사용합니다.'] },
  '&': { title: '& · 주소/비트 AND', category: '연산자', summary: '단항으로는 객체의 주소를 얻고, 이항으로는 각 비트의 AND를 계산합니다.', details: ['문맥에 따라 주소 연산과 비트 마스크 연산을 구분합니다.'] },
  '*': { title: '* · 역참조/곱셈', category: '연산자', summary: '단항으로는 포인터가 가리키는 값을 읽고, 이항으로는 곱셈을 수행합니다.', details: ['선언 안에서는 포인터 타입을 표시하는 기호로도 사용됩니다.'] },
  '++': { title: '++ · 1 증가', category: '연산자', summary: '대상의 값을 1 증가시킵니다.', details: ['전위형은 증가한 값을, 후위형은 증가 전 값을 식의 결과로 사용합니다.'] },
  '--': { title: '-- · 1 감소', category: '연산자', summary: '대상의 값을 1 감소시킵니다.', details: ['전위/후위 위치에 따라 식에서 사용되는 값의 시점이 달라집니다.'] },
  '&&': { title: '&& · 논리 AND', category: '연산자', summary: '양쪽 조건이 모두 참일 때 참이며 왼쪽이 거짓이면 오른쪽은 평가하지 않습니다.', details: ['비트 AND 연산자인 &와 구분합니다.'] },
  '||': { title: '|| · 논리 OR', category: '연산자', summary: '한쪽 조건이라도 참이면 참이며 왼쪽이 참이면 오른쪽은 평가하지 않습니다.', details: ['비트 OR 연산자인 |와 구분합니다.'] },
  '=': { title: '= · 대입', category: '연산자', summary: '오른쪽에서 계산한 값을 왼쪽 객체에 저장합니다.', details: ['같음을 비교하는 ==와 다르며 이 위치는 값 변경 지점이 됩니다.'] },
  '==': { title: '== · 같음 비교', category: '연산자', summary: '두 값이 같으면 참, 다르면 거짓을 만듭니다.', details: ['부동소수점 값은 오차 범위를 고려한 비교가 필요할 수 있습니다.'] },
  '!=': { title: '!= · 다름 비교', category: '연산자', summary: '두 값이 다르면 참을 만듭니다.', details: ['포인터의 NULL 여부 검사에도 자주 사용됩니다.'] },
  '<<': { title: '<< · 왼쪽 비트 이동', category: '연산자', summary: '정수의 비트 패턴을 지정한 수만큼 왼쪽으로 이동합니다.', details: ['레지스터 필드나 패킷 비트를 원하는 위치에 배치할 때 자주 사용합니다.'] },
  '>>': { title: '>> · 오른쪽 비트 이동', category: '연산자', summary: '정수의 비트 패턴을 지정한 수만큼 오른쪽으로 이동합니다.', details: ['signed 음수의 이동 결과는 구현 규칙을 확인하는 것이 안전합니다.'] },
  '+': { title: '+ · 덧셈/양수 표시', category: '연산자', summary: '두 값을 더하거나 단항으로 값의 부호를 그대로 둡니다.', details: ['포인터에 정수를 더하면 요소 크기 단위로 위치가 이동합니다.'] },
  '-': { title: '- · 뺄셈/음수 표시', category: '연산자', summary: '두 값의 차를 계산하거나 단항으로 부호를 반전합니다.', details: ['두 포인터의 차는 같은 배열 안의 요소 간 거리일 때 의미가 있습니다.'] },
  '/': { title: '/ · 나눗셈', category: '연산자', summary: '왼쪽 값을 오른쪽 값으로 나눕니다.', details: ['정수끼리 나누면 소수 부분은 버려지며 0으로 나누면 안 됩니다.'] },
  '%': { title: '% · 나머지', category: '연산자', summary: '정수 나눗셈 뒤의 나머지를 계산합니다.', details: ['주기 인덱스나 배수 판정에 자주 사용합니다.'] },
  '|': { title: '| · 비트 OR', category: '연산자', summary: '두 정수의 각 비트 중 하나라도 1이면 결과 비트를 1로 만듭니다.', details: ['플래그 또는 레지스터 비트를 합칠 때 자주 사용합니다.'] },
  '^': { title: '^ · 비트 XOR', category: '연산자', summary: '두 정수의 각 비트가 서로 다를 때 결과 비트를 1로 만듭니다.', details: ['특정 비트를 반전하거나 차이를 검사할 때 사용합니다.'] },
  '~': { title: '~ · 비트 반전', category: '연산자', summary: '정수의 모든 0 비트를 1로, 1 비트를 0으로 뒤집습니다.', details: ['비트 폭과 정수 승격 규칙을 함께 고려해야 합니다.'] },
  '!': { title: '! · 논리 NOT', category: '연산자', summary: '0은 참으로, 0이 아닌 값은 거짓으로 뒤집어 논리값을 만듭니다.', details: ['비트 반전 연산자인 ~와 구분합니다.'] },
  '<': { title: '< · 작음 비교', category: '연산자', summary: '왼쪽 값이 오른쪽 값보다 작으면 참입니다.', details: ['signed와 unsigned 값을 섞으면 예상과 다른 변환이 일어날 수 있습니다.'] },
  '>': { title: '> · 큼 비교', category: '연산자', summary: '왼쪽 값이 오른쪽 값보다 크면 참입니다.', details: ['경계값이 포함되는지 >=와 구분해 읽습니다.'] },
  '<=': { title: '<= · 이하 비교', category: '연산자', summary: '왼쪽 값이 오른쪽 값보다 작거나 같으면 참입니다.', details: ['배열 길이 비교에서는 마지막 유효 인덱스와 길이를 혼동하지 않아야 합니다.'] },
  '>=': { title: '>= · 이상 비교', category: '연산자', summary: '왼쪽 값이 오른쪽 값보다 크거나 같으면 참입니다.', details: ['임계값에 정확히 도달한 경우도 포함합니다.'] },
  '+=': { title: '+= · 더한 뒤 대입', category: '복합 대입 연산자', summary: '기존 값에 오른쪽 값을 더한 결과를 다시 저장합니다.', details: ['왼쪽 대상의 값 변경 지점입니다.'] },
  '-=': { title: '-= · 뺀 뒤 대입', category: '복합 대입 연산자', summary: '기존 값에서 오른쪽 값을 뺀 결과를 다시 저장합니다.', details: ['왼쪽 대상의 값 변경 지점입니다.'] },
  '|=': { title: '|= · 비트 설정 후 대입', category: '복합 대입 연산자', summary: '기존 값과 비트 OR한 결과를 다시 저장합니다.', details: ['플래그나 레지스터의 선택한 비트를 1로 만들 때 흔히 사용합니다.'] },
  '&=': { title: '&= · 비트 마스크 후 대입', category: '복합 대입 연산자', summary: '기존 값과 비트 AND한 결과를 다시 저장합니다.', details: ['~마스크와 함께 특정 비트를 0으로 지울 때 흔히 사용합니다.'] },
  '?': { title: '?: · 조건 연산자', category: '연산자', summary: '조건에 따라 두 표현식 중 하나의 값을 선택합니다.', details: ['condition ? true_value : false_value 순서로 읽습니다.'] },
  ':': { title: ': · 분기/비트필드 구분', category: '구두점', summary: '조건 연산자의 대체 값, case/default 레이블 또는 구조체 비트필드 폭을 구분합니다.', details: ['주변 문맥에 따라 의미를 결정합니다.'] },
  '(': { title: '( ) · 그룹/호출', category: '구두점', summary: '식의 계산 순서를 묶거나 함수 인자 목록을 감쌉니다.', details: ['함수 이름 뒤에서는 호출, 타입 뒤에서는 캐스트, 제어문 뒤에서는 조건을 나타낼 수 있습니다.'] },
  ')': { title: '( ) · 그룹/호출', category: '구두점', summary: '식, 함수 인자 또는 조건 구간의 끝을 표시합니다.', details: ['여는 괄호와 짝을 이루며 중첩 순서를 결정합니다.'] },
  '[': { title: '[ ] · 배열 인덱스', category: '연산자', summary: '배열이나 포인터에서 지정한 순번의 요소를 선택합니다.', details: ['C 배열 인덱스는 0부터 시작하며 범위를 자동 검사하지 않습니다.'] },
  ']': { title: '[ ] · 배열 인덱스', category: '연산자', summary: '배열 인덱스 또는 배열 선언 크기 구간의 끝을 표시합니다.', details: ['접근 인덱스가 실제 요소 수보다 작은지 확인해야 합니다.'] },
  '{': { title: '{ } · 코드/초기화 블록', category: '구두점', summary: '함수·조건·반복문의 문장 묶음 또는 객체 초기화 목록을 시작합니다.', details: ['블록은 지역 변수의 유효 범위를 만들 수 있습니다.'] },
  '}': { title: '{ } · 블록 종료', category: '구두점', summary: '코드 블록이나 초기화 목록의 끝을 표시합니다.', details: ['대응하는 여는 중괄호와 함께 범위를 결정합니다.'] },
  ';': { title: '; · 문장 종료', category: '구두점', summary: 'C 선언이나 실행문의 끝을 표시합니다.', details: ['if 또는 while 바로 뒤의 불필요한 세미콜론은 빈 문장을 만들 수 있습니다.'] },
  ',': { title: ', · 항목 구분', category: '구두점', summary: '함수 인자, 선언자, 초기화 값 등을 구분합니다.', details: ['표현식의 쉼표 연산자로 쓰이면 왼쪽을 먼저 평가하고 오른쪽 값을 결과로 사용합니다.'] },
};

export function isDirectNumericLiteral(token: string): boolean {
  return /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)[uUlLfF]*$/.test(token.trim());
}

function withinQuotedText(line: string, column: number): boolean {
  const index = Math.max(0, column - 1);
  let quote = '';
  let escaped = false;
  for (let cursor = 0; cursor < line.length; cursor += 1) {
    const char = line[cursor]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = Boolean(quote); continue; }
    if (!quote && (char === '"' || char === "'")) quote = char;
    else if (quote === char) quote = '';
    if (cursor === index) return Boolean(quote);
  }
  return false;
}

export function describeCToken(token: string, line = '', column = 1): CTokenExplanation | null {
  const rawToken = token.trim();
  const normalized = rawToken.replace(/^#/, '');
  const directive = line.match(/^\s*#\s*(include|define|ifdef|ifndef|if|elif|else|endif|pragma|undef|error)\b\s*(.*)$/);
  // A preprocessor line contains several different objects. Only the directive
  // keyword (or the leading #) is C syntax; the following identifier may be a
  // real macro symbol and must be offered to the project index first.
  if (directive && (rawToken === '#' || normalized === directive[1])) {
    const name = directive[1]!;
    const base = entries[name] ?? {
      title: `#${name} · 전처리 지시문`, category: '전처리 지시문',
      summary: 'C 컴파일이 시작되기 전에 포함 여부나 텍스트 치환을 제어합니다.',
      details: ['일반 실행문이 아니며 빌드 설정과 정의된 매크로에 따라 최종 코드가 달라질 수 있습니다.'],
    };
    return { token: `#${name}`, ...base, context: directive[2]?.trim() ? `현재 지시 내용: ${directive[2]!.trim()}` : undefined };
  }
  if (!normalized || isDirectNumericLiteral(normalized)) return null;
  const commentStart = line.indexOf('//');
  if (commentStart >= 0 && column - 1 >= commentStart) {
    return { token: '//', title: '주석 · 실행되지 않는 설명', category: 'C 문법', summary: '사람이 코드를 이해하도록 남긴 텍스트이며 컴파일되는 동작에는 포함되지 않습니다.', details: ['현재 주석이 실제 코드와 일치하는지는 별도로 검토해야 합니다.'] };
  }
  if (withinQuotedText(line, column)) {
    return { token: '문자열/문자 리터럴', title: '리터럴 · 코드에 직접 쓴 데이터', category: 'C 문법', summary: '따옴표 안에 직접 적은 문자열 또는 문자 값입니다.', details: ['문자열은 끝에 널 문자(\\0)가 붙는 문자 배열로 저장됩니다.'] };
  }
  const entry = entries[normalized] ?? operators[normalized];
  if (entry) return { token, ...entry };
  if (/^u?int(?:8|16|32|64)_t$/.test(normalized)) {
    const bits = normalized.match(/\d+/)?.[0] ?? '';
    const unsigned = normalized.startsWith('u');
    return {
      token, title: `${normalized} · 고정 폭 정수`, category: '표준 정수 타입',
      summary: `정확히 ${bits}비트를 사용하는 ${unsigned ? '부호 없는' : '부호 있는'} 정수 타입입니다.`,
      details: ['stdint.h에서 제공되며 레지스터, 통신 프레임, 파일 포맷처럼 비트 폭이 중요한 코드에 사용합니다.'],
    };
  }
  if (/^[A-Za-z_]\w*$/.test(normalized)) {
    return {
      token, title: `${normalized} · 식별자`, category: '프로젝트/외부 식별자',
      summary: '함수, 변수, 타입, 필드 또는 매크로에 붙인 이름입니다.',
      details: ['현재 프로젝트 인덱스에서 정의를 찾지 못했습니다. SDK/컴파일러 헤더, 빌드 옵션 또는 조건부 컴파일 안에서 정의됐을 수 있습니다.', '참조 위치와 include 경로를 확인하면 실제 선언을 찾는 데 도움이 됩니다.'],
    };
  }
  return null;
}

export const C_OPERATOR_TOKENS = Object.keys(operators).sort((a, b) => b.length - a.length);
