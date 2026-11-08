// 확장의 '데이터베이스' 스키마. chrome.storage.local 의 'state' 키 하나에 통째로 저장한다.
// 모든 쓰기는 서비스 워커가 직렬화해서 처리한다(store.js).
import { parseHHMM } from './dates.js';
import { TOPIC_KEYS } from './topics.js';

export const SCHEMA_VERSION = 1;

export const LANGUAGES = [
  ['', '프로그래머스 기본값'],
  ['java', 'Java'],
  ['python3', 'Python3'],
  ['cpp', 'C++'],
  ['javascript', 'JavaScript'],
  ['kotlin', 'Kotlin'],
  ['c', 'C'],
  ['csharp', 'C#'],
  ['go', 'Go'],
  ['swift', 'Swift'],
  ['ruby', 'Ruby'],
  ['scala', 'Scala'],
];

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true, // 아침 알림
  notifyTime: '09:00',
  reminderEnabled: true, // 저녁까지 못 풀었으면 한 번 더
  reminderTime: '21:00',
  retryIntervalDays: 3, // 못 푼 문제를 며칠 뒤 다시 알릴지
  maxReviewsPerDay: 2,
  minLevel: 1,
  maxLevel: 3,
  startLevel: 2, // 유형별 출발 난이도
  topics: [...TOPIC_KEYS],
  adaptive: true, // 약한 유형 비중↑ + 유형별 난이도 자동 조절
  language: '',
  autoSync: true, // 프로그래머스 '해결한 문제' 자동 동기화
});

export function createInitialState(now = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS, topics: [...DEFAULT_SETTINGS.topics] },
    records: {}, // 문제ID → 풀이 기록 (engine.newRecord)
    days: {}, // 'YYYY-MM-DD' → 그날의 추천(오늘의 문제 + 복습)
    events: [], // 시간순 활동 로그 { t, d, id, type }
    rotation: { current: {} }, // 유형 가중 라운드로빈 상태
    topicLevel: {}, // 유형 → { level, streak } 난이도 계단
    skipped: {}, // '다른 문제로 바꾸기'로 넘긴 문제 → 날짜
    opens: {}, // 기록이 없는 문제의 첫 열람 시각
    solvedSync: { ids: [], meta: {}, at: null, attemptAt: null, ok: null, signedIn: null, message: '' },
    meta: { installedAt: now, lastTickAt: null },
  };
}

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

export function normalizeSettings(input = {}, base = DEFAULT_SETTINGS) {
  const s = { ...base, ...input };
  const out = {
    enabled: Boolean(s.enabled),
    notifyTime: parseHHMM(s.notifyTime) ? s.notifyTime.padStart(5, '0') : base.notifyTime,
    reminderEnabled: Boolean(s.reminderEnabled),
    reminderTime: parseHHMM(s.reminderTime) ? s.reminderTime.padStart(5, '0') : base.reminderTime,
    retryIntervalDays: clampInt(s.retryIntervalDays, 1, 30, base.retryIntervalDays),
    maxReviewsPerDay: clampInt(s.maxReviewsPerDay, 0, 5, base.maxReviewsPerDay),
    minLevel: clampInt(s.minLevel, 1, 5, base.minLevel),
    maxLevel: clampInt(s.maxLevel, 1, 5, base.maxLevel),
    startLevel: clampInt(s.startLevel, 1, 5, base.startLevel),
    topics: Array.isArray(s.topics) ? s.topics.filter((t) => TOPIC_KEYS.includes(t)) : [...TOPIC_KEYS],
    adaptive: Boolean(s.adaptive),
    language: LANGUAGES.some(([v]) => v === s.language) ? s.language : '',
    autoSync: Boolean(s.autoSync),
  };
  if (out.minLevel > out.maxLevel) [out.minLevel, out.maxLevel] = [out.maxLevel, out.minLevel];
  out.startLevel = Math.min(out.maxLevel, Math.max(out.minLevel, out.startLevel));
  if (!out.topics.length) out.topics = [...TOPIC_KEYS];
  return out;
}

/** 저장된 값(구버전·손상 포함)을 현재 스키마로 맞춘다 */
export function migrate(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return createInitialState(now);
  const base = createInitialState(raw.meta?.installedAt ?? now);
  const state = {
    ...base,
    ...raw,
    settings: normalizeSettings(raw.settings ?? {}),
    records: raw.records && typeof raw.records === 'object' ? raw.records : {},
    days: raw.days && typeof raw.days === 'object' ? raw.days : {},
    events: Array.isArray(raw.events) ? raw.events : [],
    rotation: { current: { ...(raw.rotation?.current ?? {}) } },
    topicLevel: raw.topicLevel ?? {},
    skipped: raw.skipped ?? {},
    opens: raw.opens ?? {},
    solvedSync: { ...base.solvedSync, ...(raw.solvedSync ?? {}) },
    meta: { ...base.meta, ...(raw.meta ?? {}) },
  };
  state.schemaVersion = SCHEMA_VERSION;
  return state;
}

/** 가져오기(import)용 최소 검증 */
export function looksLikeState(obj) {
  return Boolean(obj && typeof obj === 'object' && obj.records && obj.days && obj.settings);
}
