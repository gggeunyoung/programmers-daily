// 오늘의 문제 고르기.
// 1) 유형: 가중 라운드로빈(Smooth Weighted Round-Robin). 자주 나오는 유형·약한 유형일수록 자주 돌아오되
//    같은 유형이 연달아 몰리지 않고 고르게 퍼진다.
// 2) 문제: 그 유형 안에서 '목표 난이도'에 가장 가까운 미해결 문제. 같은 조건이면 고득점 Kit → 기출 → 연습문제.
// 3) 난이도 계단: 유형별로 깔끔하게 2번 연속 풀면 +1, 놓치면 -1 (adaptive 설정일 때).
import { CATALOG } from './catalog.js';
import { diffDays } from './dates.js';
import { TOPICS } from './topics.js';

export const SKIP_COOLDOWN_DAYS = 30;
export const MAX_REROLLS_PER_DAY = 3;

/** 결정적 난수(mulberry32). 같은 날·같은 상태면 같은 문제가 나와 테스트·재현이 쉽다 */
export function seededRandom(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 추천 후보에서 빼야 하는 문제: 이미 푼 것, 진행·복습 대기 중인 것, 그만 보기, 최근에 넘긴 것 */
export function excludedIds(state, today) {
  const ex = new Set((state.solvedSync?.ids ?? []).map(Number));
  for (const r of Object.values(state.records)) {
    if (['solved', 'pending', 'missed', 'dropped'].includes(r.status)) ex.add(r.id);
  }
  for (const [id, day] of Object.entries(state.skipped ?? {})) {
    if (diffDays(day, today) < SKIP_COOLDOWN_DAYS) ex.add(Number(id));
  }
  return ex;
}

export function candidatesFor(topic, range, excluded, catalog = CATALOG) {
  return catalog.filter(
    (p) => p.topics.includes(topic) && p.level >= range.minLevel && p.level <= range.maxLevel && !excluded.has(p.id),
  );
}

/** 낮을수록 좋은 후보 */
export function candidateScore(p, topic, targetLevel) {
  return Math.abs(p.level - targetLevel) * 10 + (p.topics[0] === topic ? 0 : 4) + p.tier * 2;
}

export function pickFrom(cands, topic, targetLevel, rng = Math.random) {
  if (!cands.length) return null;
  let best = Infinity;
  for (const p of cands) best = Math.min(best, candidateScore(p, topic, targetLevel));
  const pool = cands.filter((p) => candidateScore(p, topic, targetLevel) === best);
  return pool[Math.floor(rng() * pool.length)] ?? pool[0];
}

export function targetLevelOf(state, topic) {
  const s = state.settings;
  const base = s.adaptive ? state.topicLevel?.[topic]?.level ?? s.startLevel : s.startLevel;
  return clamp(base, s.minLevel, s.maxLevel);
}

/** 유형별 실효 가중치. boosts[topic] ∈ [0,1] 이면 최대 2배까지 */
export function topicWeights(settings, boosts = {}) {
  const w = {};
  for (const t of TOPICS) {
    if (!settings.topics.includes(t.key)) continue;
    const boost = settings.adaptive ? clamp(boosts[t.key] ?? 0, 0, 1) : 0;
    w[t.key] = t.weight * (1 + boost);
  }
  return w;
}

/** Smooth Weighted Round-Robin 한 번. current 는 바꾸지 않고 다음 상태를 돌려준다 */
export function swrrPick(current, weights) {
  const keys = Object.keys(weights);
  if (!keys.length) return { topic: null, next: { ...current } };
  const next = { ...current };
  let total = 0;
  let best = null;
  for (const k of keys) {
    next[k] = (next[k] ?? 0) + weights[k];
    total += weights[k];
    if (best === null || next[k] > next[best]) best = k;
  }
  next[best] -= total;
  return { topic: best, next };
}

/**
 * 오늘의 새 문제를 고른다(상태는 바꾸지 않음).
 * @returns {{topic, problem, targetLevel, rotationNext, relaxed}|null}
 */
export function chooseDaily(state, today, { boosts = {}, rng = Math.random, catalog = CATALOG } = {}) {
  const s = state.settings;
  const excluded = excludedIds(state, today);
  const tryRange = (range, relaxed) => {
    const weights = topicWeights(s, boosts);
    const cands = {};
    for (const k of Object.keys(weights)) {
      const c = candidatesFor(k, range, excluded, catalog);
      if (c.length) cands[k] = c;
      else delete weights[k];
    }
    if (!Object.keys(weights).length) return null;
    const { topic, next } = swrrPick(state.rotation?.current ?? {}, weights);
    const targetLevel = targetLevelOf(state, topic);
    const problem = pickFrom(cands[topic], topic, targetLevel, rng);
    return problem ? { topic, problem, targetLevel, rotationNext: next, relaxed } : null;
  };
  return (
    tryRange({ minLevel: s.minLevel, maxLevel: s.maxLevel }, false) ??
    // 설정한 난이도 범위의 문제를 다 풀었으면 범위를 풀어서라도 추천
    tryRange({ minLevel: 1, maxLevel: 5 }, true)
  );
}

/** 같은 유형 안에서 다른 문제로 바꾸기용 */
export function chooseInTopic(state, today, topic, { rng = Math.random, exclude = [], catalog = CATALOG } = {}) {
  const s = state.settings;
  const excluded = excludedIds(state, today);
  for (const id of exclude) excluded.add(Number(id));
  const targetLevel = targetLevelOf(state, topic);
  const inRange = candidatesFor(topic, s, excluded, catalog);
  const cands = inRange.length ? inRange : candidatesFor(topic, { minLevel: 1, maxLevel: 5 }, excluded, catalog);
  const problem = pickFrom(cands, topic, targetLevel, rng);
  return problem ? { topic, problem, targetLevel } : null;
}

/** 해결했을 때 난이도 계단: 깔끔하게(놓친 적 없이, 오답 1회 이하) 2번 연속이면 한 단계 올린다 */
export function adjustOnSolved(state, topic, clean) {
  if (!state.settings.adaptive || !topic) return;
  const s = state.settings;
  const cur = state.topicLevel[topic] ?? { level: s.startLevel, streak: 0 };
  if (clean) {
    cur.streak += 1;
    if (cur.streak >= 2) {
      cur.level = clamp(cur.level + 1, s.minLevel, s.maxLevel);
      cur.streak = 0;
    }
  } else {
    cur.streak = 0;
  }
  state.topicLevel[topic] = cur;
}

/** 놓쳤을 때 난이도 계단: 한 단계 내린다 */
export function adjustOnMissed(state, topic) {
  if (!state.settings.adaptive || !topic) return;
  const s = state.settings;
  const cur = state.topicLevel[topic] ?? { level: s.startLevel, streak: 0 };
  cur.level = clamp(cur.level - 1, s.minLevel, s.maxLevel);
  cur.streak = 0;
  state.topicLevel[topic] = cur;
}
