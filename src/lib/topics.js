// 추천에 쓰는 알고리즘 유형 정의.
// weight 는 국내 기업 코딩테스트(카카오·네이버·삼성 등)에서 자주 나오는 정도를 반영한 기본 출제 비중이다.
// 추천기는 이 비중으로 유형을 '골고루, 그러나 자주 나오는 유형은 더 자주' 돌린다(가중 라운드로빈).

export const TOPICS = [
  {
    key: 'impl',
    name: '구현·시뮬레이션',
    short: '구현',
    weight: 3,
    desc: '문제 조건을 빠짐없이 코드로 옮기는 유형. 카카오·삼성 코테의 단골.',
    tip: '입력·상태·종료 조건을 먼저 적고, 기능별로 함수를 나눠 짜면 디버깅 시간이 줄어듭니다.',
  },
  {
    key: 'bfs',
    name: 'DFS·BFS',
    short: 'DFS/BFS',
    weight: 3,
    desc: '격자·그래프 탐색, 최단 거리(BFS), 연결 요소 세기.',
    tip: 'visited 표시 시점(큐에 넣을 때)과 방향 배열 dx/dy 템플릿을 손에 익히세요.',
  },
  {
    key: 'brute',
    name: '완전탐색·백트래킹',
    short: '완전탐색',
    weight: 2,
    desc: '모든 경우를 따지되 가지치기로 줄이는 유형. 순열·조합·부분집합.',
    tip: '경우의 수를 먼저 계산해 시간 안에 되는지 확인하고, 순열/조합 재귀 템플릿을 외워두세요.',
  },
  {
    key: 'dp',
    name: '동적계획법',
    short: 'DP',
    weight: 2,
    desc: '작은 문제의 답을 저장해 큰 문제를 푸는 유형.',
    tip: 'dp[i]의 의미 → 점화식 → 초기값 순서로 종이에 먼저 쓰고 코딩하세요.',
  },
  {
    key: 'greedy',
    name: '그리디',
    short: '그리디',
    weight: 2,
    desc: '매 순간 최선의 선택이 전체 최적이 되는 유형. 정렬과 자주 같이 나옵니다.',
    tip: '정렬 기준을 세운 뒤 반례를 2~3개 손으로 만들어 검증하는 습관을 들이세요.',
  },
  {
    key: 'string',
    name: '문자열',
    short: '문자열',
    weight: 2,
    desc: '파싱·치환·압축 등 문자열 처리.',
    tip: 'split/정규식/StringBuilder, 문자↔숫자 변환을 한 번 정리해두면 실수가 크게 줄어듭니다.',
  },
  {
    key: 'hash',
    name: '해시',
    short: '해시',
    weight: 2,
    desc: 'Map/Set으로 개수 세기·빠른 조회.',
    tip: 'getOrDefault·merge 로 개수 세는 패턴, 키를 문자열로 합치는 패턴을 익히세요.',
  },
  {
    key: 'stack',
    name: '스택·큐',
    short: '스택/큐',
    weight: 2,
    desc: '가장 최근 것(스택)·먼저 온 것(큐)을 다루는 유형, 모노토닉 스택.',
    tip: '"짝 맞추기·되돌리기"는 스택, "순서대로 처리"는 큐부터 떠올리세요.',
  },
  {
    key: 'sort',
    name: '정렬',
    short: '정렬',
    weight: 1,
    desc: '다중 조건 정렬, 정렬 후 탐색.',
    tip: 'Comparator 다중 조건 정렬과 안정 정렬 여부를 확인하세요.',
  },
  {
    key: 'heap',
    name: '힙·우선순위 큐',
    short: '힙',
    weight: 1,
    desc: '매번 최솟값/최댓값을 꺼내야 하는 유형.',
    tip: '"매번 가장 작은/큰 것을 꺼낸다"는 문장이 보이면 PriorityQueue를 떠올리세요.',
  },
  {
    key: 'bsearch',
    name: '이분탐색',
    short: '이분탐색',
    weight: 1,
    desc: '정렬된 범위 탐색, 답을 정해놓고 판정하는 파라메트릭 서치.',
    tip: '"최솟값의 최댓값" 같은 문장 → 답을 mid로 두고 가능 여부를 판정하는 패턴.',
  },
  {
    key: 'graph',
    name: '그래프·트리',
    short: '그래프',
    weight: 1,
    desc: '최단 경로(다익스트라·플로이드), 유니온 파인드, MST, 트리 순회.',
    tip: '다익스트라·플로이드·유니온 파인드 템플릿을 직접 짜서 저장해두세요.',
  },
  {
    key: 'twoptr',
    name: '투포인터·누적합',
    short: '투포인터',
    weight: 1,
    desc: '연속 구간 탐색, 슬라이딩 윈도우, 구간 합(imos).',
    tip: '구간 합은 누적합, 연속 구간 최적화는 투포인터부터 떠올리세요.',
  },
  {
    key: 'math',
    name: '수학·비트',
    short: '수학',
    weight: 1,
    desc: '소수·최대공약수·진법 변환·비트 연산.',
    tip: '에라토스테네스의 체, 유클리드 호제법, 진법 변환 함수를 템플릿으로 만들어두세요.',
  },
];

export const TOPIC_KEYS = TOPICS.map((t) => t.key);
export const TOPIC_MAP = Object.fromEntries(TOPICS.map((t) => [t.key, t]));

export function topicName(key) {
  return TOPIC_MAP[key]?.name ?? '미분류';
}

export function topicShort(key) {
  return TOPIC_MAP[key]?.short ?? '미분류';
}
