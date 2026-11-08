// 상태 전이(도메인 로직). 함수들은 state 를 직접 바꾸고, 저장은 호출자(store.update)가 한다.
// 서비스 워커·테스트·개발용 하네스가 모두 이 파일을 그대로 쓴다.
//
// 문제 기록(record)의 상태:
//   pending  오늘 추천됨(새 문제 또는 복습), 아직 못 풂
//   missed   추천된 날 못 풂 → nextReviewOn 에 다시 추천(복습)
//   solved   해결 (detect=채점 결과 감지, sync=프로그래머스 동기화, manual=직접 체크)
//   dropped  '이 문제 그만 보기'
//   tracked  추천 없이 스스로 풀어본 문제(제출 기록만 있음)
import { weaknessBoosts } from './analytics.js';
import { getProblem } from './catalog.js';
import { addDays, atTime, dateKey } from './dates.js';
import {
  adjustOnMissed,
  adjustOnSolved,
  chooseDaily,
  chooseInTopic,
  MAX_REROLLS_PER_DAY,
  seededRandom,
} from './recommender.js';
import { normalizeSettings } from './state.js';

const MAX_EVENTS = 3000;
const MAX_OPENS = 300;
const REMIND_GAP_MS = 2 * 3600_000;

export function newRecord(id, hint = {}, origin = 'self', now = Date.now()) {
  const p = getProblem(id);
  return {
    id: Number(id),
    title: p?.title ?? hint.title ?? `문제 ${id}`,
    level: p?.level ?? (Number.isFinite(hint.level) ? hint.level : null),
    topics: p ? [...p.topics] : [],
    part: p?.part ?? hint.part ?? '',
    origin, // daily | self
    status: 'tracked',
    recTopic: null,
    recommendedOn: [],
    firstOpenedAt: null,
    lastOpenedAt: null,
    submits: 0,
    wrong: 0,
    lastSubmitAt: null,
    lang: null,
    solvedAt: null,
    solvedOn: null,
    solvedVia: null,
    missCount: 0, // 추천일에 못 푼 횟수(복습 예약용)
    triedMisses: 0, // 그중 열어보거나 제출해 보고도 못 푼 횟수(약점 근거)
    nextReviewOn: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function pushEvent(state, ev) {
  state.events.push(ev);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}

function markSolved(state, r, at, via) {
  r.status = 'solved';
  r.solvedAt = at;
  r.solvedOn = dateKey(at);
  r.solvedVia = via;
  r.nextReviewOn = null;
  r.updatedAt = at;
  if (r.recommendedOn?.length) {
    const clean = (r.triedMisses ?? 0) === 0 && (r.wrong ?? 0) <= 1;
    adjustOnSolved(state, r.recTopic ?? r.topics?.[0], clean);
  }
  pushEvent(state, { t: at, d: r.solvedOn, id: r.id, type: 'solve', via });
}

/** 지난날 추천된 문제 중 못 푼 것을 '놓침'으로 바꾸고 다시 볼 날짜를 잡는다 */
export function processRollover(state, today, now = Date.now()) {
  const missed = [];
  const keys = Object.keys(state.days)
    .filter((k) => k < today && !state.days[k].closed)
    .sort();
  for (const k of keys) {
    const day = state.days[k];
    const items = [];
    if (day.problemId) items.push({ id: day.problemId, kind: 'daily' });
    for (const id of day.reviewIds ?? []) items.push({ id, kind: 'review' });
    for (const { id, kind } of items) {
      const r = state.records[id];
      if (!r || r.status !== 'pending') continue;
      // 그날 열어보거나 제출해 봤는데 못 푼 것만 '어려웠다'는 근거로 친다(바빠서 못 연 날은 제외)
      const tried =
        (r.lastOpenedAt && dateKey(r.lastOpenedAt) >= k) || (r.lastSubmitAt && dateKey(r.lastSubmitAt) >= k);
      r.status = 'missed';
      r.missCount += 1;
      if (tried) r.triedMisses = (r.triedMisses ?? 0) + 1;
      r.nextReviewOn = addDays(k, state.settings.retryIntervalDays);
      r.updatedAt = now;
      if (kind === 'daily' && tried && r.triedMisses === 1) adjustOnMissed(state, day.topic ?? r.topics?.[0]);
      pushEvent(state, { t: now, d: k, id, type: 'miss', tried: Boolean(tried) });
      missed.push(id);
    }
    day.closed = true;
  }
  return missed;
}

/** 오늘의 추천(새 문제 1개 + 다시 볼 문제 최대 N개)을 만든다. 이미 있으면 그대로 둔다 */
export function ensureDay(state, today, now = Date.now()) {
  if (state.days[today]) return { created: false, day: state.days[today] };
  const s = state.settings;

  const due = Object.values(state.records)
    .filter((r) => r.status === 'missed' && r.nextReviewOn && r.nextReviewOn <= today)
    .sort((a, b) => a.nextReviewOn.localeCompare(b.nextReviewOn) || b.missCount - a.missCount || a.id - b.id)
    .slice(0, s.maxReviewsPerDay);
  for (const r of due) {
    r.status = 'pending';
    r.recommendedOn.push(today);
    r.updatedAt = now;
  }

  const day = {
    problemId: null,
    topic: null,
    targetLevel: null,
    relaxed: false,
    reviewIds: due.map((r) => r.id),
    createdAt: now,
    notifiedAt: null,
    remindedAt: null,
    rerolls: 0,
    closed: false,
  };

  const rng = seededRandom(`${today}#${state.meta?.installedAt ?? 0}`);
  const pick = chooseDaily(state, today, { boosts: weaknessBoosts(state, today), rng });
  if (pick) {
    state.rotation.current = pick.rotationNext;
    assignDaily(state, day, pick, today, now);
  }
  state.days[today] = day;
  return { created: true, day };
}

function assignDaily(state, day, pick, today, now) {
  const id = pick.problem.id;
  const r = state.records[id] ?? newRecord(id, {}, 'daily', now);
  r.origin = 'daily';
  r.status = 'pending';
  r.recTopic = pick.topic;
  r.recommendedOn.push(today);
  r.updatedAt = now;
  state.records[id] = r;
  day.problemId = id;
  day.topic = pick.topic;
  day.targetLevel = pick.targetLevel;
  day.relaxed = Boolean(pick.relaxed);
  pushEvent(state, { t: now, d: today, id, type: 'recommend' });
}

/** 모든 동작 전에: 날짜 넘김 처리 + 오늘 추천 보장. 오늘 날짜 키를 돌려준다 */
export function prepare(state, now = Date.now()) {
  const today = dateKey(now);
  processRollover(state, today, now);
  ensureDay(state, today, now);
  return today;
}

/** 채점 결과(정답/오답) 기록 */
export function recordSubmission(state, { id, passed, title, level, at = Date.now(), lang = null }) {
  const pid = Number(id);
  let r = state.records[pid];
  if (!r) {
    r = newRecord(pid, { title, level }, 'self', at);
    r.firstOpenedAt = state.opens?.[pid] ?? null;
    state.records[pid] = r;
  }
  r.submits += 1;
  r.lastSubmitAt = at;
  if (lang) r.lang = lang;
  r.updatedAt = at;
  pushEvent(state, { t: at, d: dateKey(at), id: pid, type: passed ? 'pass' : 'fail' });
  let firstSolve = false;
  if (passed) {
    if (r.status !== 'solved') {
      firstSolve = true;
      markSolved(state, r, at, 'detect');
    }
  } else if (r.status !== 'solved') {
    r.wrong += 1;
  }
  return { record: r, firstSolve };
}

/** 문제 페이지를 연 시각(풀이 시간 계산용) */
export function recordOpen(state, { id, at = Date.now() }) {
  const pid = Number(id);
  const r = state.records[pid];
  if (r) {
    if (!r.firstOpenedAt) r.firstOpenedAt = at;
    r.lastOpenedAt = at;
    return r;
  }
  if (!state.opens[pid]) {
    state.opens[pid] = at;
    const keys = Object.keys(state.opens);
    if (keys.length > MAX_OPENS) {
      keys
        .sort((a, b) => state.opens[a] - state.opens[b])
        .slice(0, keys.length - MAX_OPENS)
        .forEach((k) => delete state.opens[k]);
    }
  }
  return null;
}

/**
 * 프로그래머스 '해결한 문제' 목록 반영. 해결 여부는 되돌아가지 않으므로 합집합만 한다.
 * @param {{id:number,title?:string,level?:number,part?:string}[]} solvedList
 */
export function applySync(state, solvedList, at = Date.now(), { skipIds = [] } = {}) {
  const skip = new Set(skipIds.map(Number));
  const set = new Set((state.solvedSync.ids ?? []).map(Number));
  const meta = state.solvedSync.meta ?? {};
  let added = 0;
  for (const item of solvedList) {
    const id = Number(item.id);
    if (!Number.isFinite(id)) continue;
    if (!set.has(id)) {
      set.add(id);
      added += 1;
    }
    if (!getProblem(id) && item.title) meta[id] = { title: item.title, level: item.level ?? null, part: item.part ?? '' };
  }
  state.solvedSync.ids = [...set];
  state.solvedSync.meta = meta;
  state.solvedSync.at = at;
  const newlySolved = [];
  for (const r of Object.values(state.records)) {
    if (r.status !== 'solved' && set.has(r.id) && !skip.has(r.id)) {
      markSolved(state, r, at, 'sync');
      newlySolved.push(r.id);
    }
  }
  return { added, newlySolved, total: set.size };
}

/**
 * 첫 동기화 전에 추천된 '사실 이미 푼 문제'(손도 안 댄 채 해결 목록에 있는 오늘의 문제)를 찾는다.
 * 이런 문제는 해결로 치지 않고 다른 문제로 바꿔야 한다.
 */
export function staleDailyIds(state, solvedList, now = Date.now()) {
  if ((state.solvedSync.ids ?? []).length > 0) return [];
  const today = dateKey(now);
  const day = state.days[today];
  if (!day?.problemId) return [];
  const r = state.records[day.problemId];
  const solvedIds = new Set(solvedList.map((x) => Number(x.id)));
  if (r && r.status === 'pending' && r.submits === 0 && !r.firstOpenedAt && solvedIds.has(r.id)) return [r.id];
  return [];
}

/** 팝업·대시보드에서 직접 하는 조작 */
export function manualAction(state, { id, action, at = Date.now() }) {
  const pid = Number(id);
  const today = dateKey(at);
  let r = state.records[pid];
  if (!r) {
    if (action !== 'solved') return { ok: false, reason: 'no-record' };
    r = newRecord(pid, {}, 'self', at);
    state.records[pid] = r;
  }
  switch (action) {
    case 'solved':
      if (r.status !== 'solved') markSolved(state, r, at, 'manual');
      return { ok: true, record: r };
    case 'unsolve': {
      // 잘못 누른 '풀었어요' 되돌리기
      if (r.status !== 'solved') return { ok: false, reason: 'not-solved' };
      const isToday = r.recommendedOn.includes(today);
      r.status = isToday ? 'pending' : r.recommendedOn.length ? 'missed' : 'tracked';
      r.nextReviewOn = r.status === 'missed' ? today : null;
      r.solvedAt = null;
      r.solvedOn = null;
      r.solvedVia = null;
      r.updatedAt = at;
      // 동기화 목록에서도 빼야 다시 '해결'로 덮이지 않는다
      state.solvedSync.ids = (state.solvedSync.ids ?? []).filter((x) => Number(x) !== pid);
      pushEvent(state, { t: at, d: today, id: pid, type: 'unsolve' });
      return { ok: true, record: r };
    }
    case 'drop':
      if (r.status === 'solved') return { ok: false, reason: 'solved' };
      r.status = 'dropped';
      r.nextReviewOn = null;
      r.updatedAt = at;
      pushEvent(state, { t: at, d: today, id: pid, type: 'drop' });
      return { ok: true, record: r };
    case 'restore':
      if (r.status !== 'dropped') return { ok: false, reason: 'not-dropped' };
      r.status = 'missed';
      r.nextReviewOn = addDays(today, 1);
      r.updatedAt = at;
      return { ok: true, record: r };
    case 'review-now':
      // 복습 날짜를 오늘로 당기기(내일 추천에 포함)
      if (r.status !== 'missed') return { ok: false, reason: 'not-missed' };
      r.nextReviewOn = today;
      r.updatedAt = at;
      return { ok: true, record: r };
    default:
      return { ok: false, reason: 'unknown-action' };
  }
}

/**
 * 오늘의 새 문제를 같은 유형의 다른 문제로 바꾼다.
 * force: 시스템이 바꾸는 경우(이미 푼 문제로 밝혀짐) — 횟수 제한·'넘긴 문제' 기록 없이 바꾼다
 */
export function rerollToday(state, now = Date.now(), { force = false } = {}) {
  const today = dateKey(now);
  const day = state.days[today];
  if (!day || !day.problemId) return { ok: false, reason: 'no-problem' };
  if (!force && day.rerolls >= MAX_REROLLS_PER_DAY) return { ok: false, reason: 'limit' };
  const old = state.records[day.problemId];
  if (old?.status === 'solved') return { ok: false, reason: 'solved' };

  const rng = seededRandom(`${today}#reroll${day.rerolls}#${state.meta?.installedAt ?? 0}`);
  const pick = chooseInTopic(state, today, day.topic, { rng, exclude: [day.problemId] });
  if (!pick) return { ok: false, reason: 'no-candidate' };

  if (old) {
    old.recommendedOn = old.recommendedOn.filter((d) => d !== today);
    if (old.submits === 0 && !old.recommendedOn.length && !old.firstOpenedAt) {
      delete state.records[old.id];
    } else {
      old.status = old.recommendedOn.length ? 'missed' : 'tracked';
      old.nextReviewOn = old.status === 'missed' ? addDays(today, state.settings.retryIntervalDays) : null;
    }
    if (!force) {
      state.skipped[old.id] = today;
      pushEvent(state, { t: now, d: today, id: old.id, type: 'skip' });
    }
  }
  if (!force) day.rerolls += 1;
  assignDaily(state, day, { ...pick, relaxed: false }, today, now);
  return { ok: true, day };
}

export function updateSettings(state, patch) {
  state.settings = normalizeSettings(patch, state.settings);
  return state.settings;
}

/**
 * 지금 보내야 할 알림. 같은 날 같은 종류는 한 번만.
 * consume: 아침 알림 시각이 지나 오늘 몫을 처리했다(보낼 게 없어도 notifiedAt 을 찍는다)
 * @returns {{consume:boolean, daily:boolean, review:boolean, remind:boolean, suppressRemind:boolean}}
 */
export function notificationPlan(state, now = Date.now()) {
  const s = state.settings;
  const today = dateKey(now);
  const day = state.days[today];
  const plan = { consume: false, daily: false, review: false, remind: false, suppressRemind: false };
  if (!day) return plan;
  const dailyPending = day.problemId && state.records[day.problemId]?.status === 'pending';
  const reviewPending = (day.reviewIds ?? []).some((id) => state.records[id]?.status === 'pending');
  const afterNotify = now >= atTime(today, s.notifyTime);
  const afterRemind = now >= atTime(today, s.reminderTime);

  if (s.enabled && !day.notifiedAt && afterNotify) {
    plan.consume = true;
    plan.daily = Boolean(dailyPending);
    plan.review = reviewPending;
    // 늦게 켜서 아침 알림과 저녁 알림이 겹치면 저녁 알림은 생략
    if (afterRemind) plan.suppressRemind = true;
  }
  if (s.reminderEnabled && !day.remindedAt && afterRemind && !plan.suppressRemind && (dailyPending || reviewPending)) {
    const last = day.notifiedAt ?? 0;
    if (now - last >= REMIND_GAP_MS) plan.remind = true;
  }
  return plan;
}

/** 날짜별 기록 등 오래된 데이터 정리(1년 넘은 day 항목) */
export function compact(state, today) {
  const cutoff = addDays(today, -400);
  for (const k of Object.keys(state.days)) if (k < cutoff) delete state.days[k];
  for (const [id, d] of Object.entries(state.skipped)) if (d < addDays(today, -60)) delete state.skipped[id];
}
