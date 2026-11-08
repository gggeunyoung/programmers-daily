// 날짜 유틸. 하루의 경계는 사용자 PC의 현지 시간(한국이면 KST) 자정이다.
// 날짜 키는 'YYYY-MM-DD' 문자열로 저장해 비교·정렬이 문자열 비교로 된다.

const DAY_MS = 86_400_000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export function dateKey(input = Date.now()) {
  const d = input instanceof Date ? input : new Date(input);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

/** b - a (일). 같은 날이면 0 */
export function diffDays(a, b) {
  return Math.round((parseKey(b) - parseKey(a)) / DAY_MS);
}

export function parseHHMM(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, min };
}

/** 해당 날짜의 HH:MM 시각(ms) */
export function atTime(key, hhmm) {
  const t = parseHHMM(hhmm) ?? { h: 9, min: 0 };
  const d = parseKey(key);
  d.setHours(t.h, t.min, 0, 0);
  return d.getTime();
}

/** now 이후(초과) 가장 가까운 HH:MM 시각(ms) */
export function nextOccurrence(hhmm, now = Date.now()) {
  const today = dateKey(now);
  const t = atTime(today, hhmm);
  return t > now ? t : atTime(addDays(today, 1), hhmm);
}

export function weekdayKo(key) {
  return WEEKDAYS[parseKey(key).getDay()];
}

/** '11.08 (일)' */
export function prettyDate(key) {
  const [, m, d] = key.split('-');
  return `${m}.${d} (${weekdayKo(key)})`;
}

/** 'n일 전' 같은 상대 표현 */
export function relativeDay(key, today) {
  const n = diffDays(key, today);
  if (n === 0) return '오늘';
  if (n === 1) return '어제';
  if (n > 1) return `${n}일 전`;
  if (n === -1) return '내일';
  return `${-n}일 후`;
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '-';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h < 48) return rest ? `${h}시간 ${rest}분` : `${h}시간`;
  return `${Math.round(h / 24)}일`;
}
