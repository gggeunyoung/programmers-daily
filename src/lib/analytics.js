// 약점 분석 · 통계.
// 문제마다 '고전 점수'(0=깔끔하게 해결, 1=못 풂)를 매기고, 유형별로 베이지안 평활 평균을 낸다.
// 적게 푼 유형이 1~2문제 결과로 극단값이 되지 않도록 전체 평균(prior)을 가상 관측 K개만큼 섞는다.
import { CATALOG } from './catalog.js';
import { addDays, dateKey, diffDays } from './dates.js';
import { TOPICS } from './topics.js';

export const SMOOTHING_K = 2;
export const DEFAULT_PRIOR = 0.35;
export const MIN_EVIDENCE = 1.5; // 이 이상 근거가 쌓인 유형만 약점 순위에 올린다

/**
 * 문제 하나에서 얼마나 고전했는지 0~1. 판단할 근거가 없으면 null.
 * '놓침'은 그날 열어보거나 제출해 본 경우(triedMisses)만 근거로 친다 — 바빠서 못 연 날은 실력과 무관하다.
 */
export function struggleOf(r, today) {
  const tried = (r.triedMisses ?? 0) > 0;
  switch (r.status) {
    case 'solved': {
      let s = tried ? 0.5 : 0; // 시도했는데 그날 못 풀고 나중에 풀었다
      s += Math.min(r.wrong ?? 0, 4) * 0.1; // 오답 제출 1회당 0.1 (최대 0.4)
      return Math.min(1, s);
    }
    case 'missed':
      return tried || (r.wrong ?? 0) > 0 ? 1 : null;
    case 'dropped':
      return tried || (r.submits ?? 0) > 0 || r.firstOpenedAt ? 1 : 0.6; // 열어보지도 않고 그만 본 것도 약한 신호
    case 'pending':
      return tried ? 1 : null; // 오늘 처음 추천됐거나, 전에 안 열어본 복습 문제는 판단 보류
    case 'tracked':
      // 추천 없이 스스로 풀어보다 하루 넘게 못 푼 문제
      if ((r.submits ?? 0) > 0 && r.lastSubmitAt && diffDays(dateKey(r.lastSubmitAt), today) >= 1) return 0.8;
      return null;
    default:
      return null;
  }
}

function emptyStat(t) {
  return {
    key: t.key,
    name: t.name,
    short: t.short,
    evidence: 0, // 가중 문제 수 (주유형 1, 보조유형 0.5)
    struggleSum: 0,
    count: 0,
    solved: 0,
    unsolved: 0,
    lateSolved: 0,
    wrongSum: 0,
    timeSum: 0,
    timeN: 0,
    levelSum: 0,
    ids: [],
  };
}

export function allSolvedIds(state) {
  const set = new Set((state.solvedSync?.ids ?? []).map(Number));
  for (const r of Object.values(state.records)) if (r.status === 'solved') set.add(r.id);
  return set;
}

export function computeTopicStats(state, today = dateKey()) {
  const stats = Object.fromEntries(TOPICS.map((t) => [t.key, emptyStat(t)]));
  let gSum = 0;
  let gN = 0;
  for (const r of Object.values(state.records)) {
    const s = struggleOf(r, today);
    if (s == null) continue;
    gSum += s;
    gN += 1;
    (r.topics ?? []).forEach((key, i) => {
      const st = stats[key];
      if (!st) return;
      const w = i === 0 ? 1 : 0.5;
      st.evidence += w;
      st.struggleSum += w * s;
      st.count += 1;
      st.levelSum += r.level ?? 0;
      st.wrongSum += r.wrong ?? 0;
      st.ids.push(r.id);
      if (r.status === 'solved') {
        st.solved += 1;
        if ((r.triedMisses ?? 0) > 0) st.lateSolved += 1;
        if (r.missCount === 0 && r.firstOpenedAt && r.solvedAt > r.firstOpenedAt) {
          st.timeSum += r.solvedAt - r.firstOpenedAt;
          st.timeN += 1;
        }
      } else {
        st.unsolved += 1;
      }
    });
  }
  const prior = gN >= 3 ? gSum / gN : DEFAULT_PRIOR;
  const solvedSet = allSolvedIds(state);
  for (const t of TOPICS) {
    const st = stats[t.key];
    const inTopic = CATALOG.filter((p) => p.topics[0] === t.key);
    st.catalogTotal = inTopic.length;
    st.catalogSolved = inTopic.filter((p) => solvedSet.has(p.id)).length;
    st.weakness = (st.struggleSum + SMOOTHING_K * prior) / (st.evidence + SMOOTHING_K);
    st.confidence = st.evidence / (st.evidence + SMOOTHING_K);
    st.score = Math.round(st.weakness * 100);
    st.avgWrong = st.count ? st.wrongSum / st.count : null;
    st.avgSolveMs = st.timeN ? st.timeSum / st.timeN : null;
    st.avgLevel = st.count ? st.levelSum / st.count : null;
    st.enough = st.evidence >= MIN_EVIDENCE;
  }
  return { stats, prior, counted: gN };
}

/** 추천 비중 가산치(0~1): 평균보다 약한 만큼, 근거가 쌓인 만큼 */
export function weaknessBoosts(state, today = dateKey()) {
  const { stats, prior } = computeTopicStats(state, today);
  const out = {};
  for (const st of Object.values(stats)) {
    out[st.key] = Math.min(1, Math.max(0, st.weakness - prior) * 2 * st.confidence);
  }
  return out;
}

/** 약한 유형 순위(근거 충분한 유형만) */
export function rankWeakTopics(statsResult) {
  return Object.values(statsResult.stats)
    .filter((st) => st.enough)
    .sort((a, b) => b.weakness - a.weakness || b.evidence - a.evidence);
}

export function explainTopic(st) {
  if (!st.count) return '아직 푼 기록이 없어요';
  const parts = [`${st.count}문제 중 ${st.solved}개 해결`];
  if (st.unsolved) parts.push(`미해결 ${st.unsolved}`);
  if (st.lateSolved) parts.push(`늦게 해결 ${st.lateSolved}`);
  if (st.avgWrong != null && st.avgWrong >= 0.5) parts.push(`평균 오답 ${st.avgWrong.toFixed(1)}회`);
  return parts.join(' · ');
}

/** 날짜 → 그날 해결한 문제 수 (잔디·연속 기록용) */
export function solvedByDay(state) {
  const m = {};
  for (const r of Object.values(state.records)) {
    if (r.status === 'solved' && r.solvedOn) m[r.solvedOn] = (m[r.solvedOn] ?? 0) + 1;
  }
  return m;
}

export function currentStreak(byDay, today) {
  let d = byDay[today] ? today : addDays(today, -1);
  let n = 0;
  while (byDay[d]) {
    n += 1;
    d = addDays(d, -1);
  }
  return n;
}

export function longestStreak(byDay) {
  const days = Object.keys(byDay).sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of days) {
    run = prev && diffDays(prev, d) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

/** 복습 대기열: 놓친 문제를 다시 볼 날짜순으로 */
export function reviewQueue(state, today) {
  return Object.values(state.records)
    .filter((r) => r.status === 'missed' && r.nextReviewOn)
    .sort((a, b) => a.nextReviewOn.localeCompare(b.nextReviewOn) || b.missCount - a.missCount || a.id - b.id)
    .map((r) => ({ ...r, due: r.nextReviewOn <= today }));
}

export function summarize(state, today = dateKey()) {
  const recs = Object.values(state.records);
  const recommended = recs.filter((r) => r.recommendedOn?.length);
  const solvedRecommended = recommended.filter((r) => r.status === 'solved');
  const byDay = solvedByDay(state);
  const month = today.slice(0, 7);
  const queue = reviewQueue(state, today);
  return {
    recommended: recommended.length,
    solvedRecommended: solvedRecommended.length,
    solveRate: recommended.length ? solvedRecommended.length / recommended.length : null,
    streak: currentStreak(byDay, today),
    longest: longestStreak(byDay),
    solvedThisMonth: Object.entries(byDay)
      .filter(([d]) => d.startsWith(month))
      .reduce((a, [, n]) => a + n, 0),
    solvedAll: allSolvedIds(state).size,
    reviewWaiting: queue.length,
    reviewDue: queue.filter((r) => r.due).length,
    byDay,
  };
}
