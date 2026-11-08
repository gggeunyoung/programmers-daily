import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeTopicStats, rankWeakTopics, reviewQueue, summarize, weaknessBoosts } from '../src/lib/analytics.js';
import { CATALOG, getProblem } from '../src/lib/catalog.js';
import { addDays, atTime, dateKey, diffDays, nextOccurrence } from '../src/lib/dates.js';
import {
  applySync,
  ensureDay,
  manualAction,
  markSlots,
  muteToday,
  notificationPlan,
  prepare,
  processRollover,
  recordOpen,
  recordSubmission,
  rerollToday,
  staleDailyIds,
  updateSettings,
} from '../src/lib/engine.js';
import { chooseDaily, swrrPick, topicWeights } from '../src/lib/recommender.js';
import { createInitialState, migrate, normalizeSettings } from '../src/lib/state.js';
import { createStore, memoryArea } from '../src/lib/store.js';
import { TOPICS } from '../src/lib/topics.js';

const at = (key, hhmm = '10:00') => atTime(key, hhmm);
const D0 = '2026-11-09'; // 월요일

function fresh(settings = {}) {
  const s = createInitialState(at(D0, '08:00'));
  s.settings = normalizeSettings(settings);
  return s;
}

test('dates: 날짜 키 계산', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(diffDays('2026-02-27', '2026-03-01'), 2);
  assert.equal(dateKey(at(D0, '23:59')), D0);
  const now = at(D0, '10:00');
  assert.equal(nextOccurrence('09:00', now), at(addDays(D0, 1), '09:00'));
  assert.equal(nextOccurrence('11:30', now), at(D0, '11:30'));
});

test('카탈로그: 모든 문제에 유효한 유형·레벨이 있다', () => {
  const keys = new Set(TOPICS.map((t) => t.key));
  assert.ok(CATALOG.length > 200);
  for (const p of CATALOG) {
    assert.ok(p.topics.length >= 1, `${p.id} 유형 없음`);
    for (const t of p.topics) assert.ok(keys.has(t), `${p.id} 잘못된 유형 ${t}`);
    assert.ok(p.level >= 1 && p.level <= 5);
  }
  assert.equal(getProblem(42576).title, '완주하지 못한 선수');
});

test('가중 라운드로빈: 비중대로 고르게 돈다', () => {
  const weights = { a: 3, b: 2, c: 1 };
  let cur = {};
  const seq = [];
  for (let i = 0; i < 12; i += 1) {
    const { topic, next } = swrrPick(cur, weights);
    seq.push(topic);
    cur = next;
  }
  const count = (k) => seq.filter((x) => x === k).length;
  assert.deepEqual([count('a'), count('b'), count('c')], [6, 4, 2]);
  // 같은 유형이 3번 연속 나오지 않는다
  for (let i = 2; i < seq.length; i += 1) assert.ok(!(seq[i] === seq[i - 1] && seq[i] === seq[i - 2]));
});

test('추천: 설정 범위 안에서, 이미 푼 문제는 빼고 고른다', () => {
  const s = fresh({ minLevel: 2, maxLevel: 2 });
  s.solvedSync.ids = CATALOG.filter((p) => p.topics.includes('impl') && p.level === 2).map((p) => p.id);
  for (let i = 0; i < 30; i += 1) {
    const pick = chooseDaily(s, D0, { rng: () => 0.5 });
    assert.ok(pick);
    assert.equal(pick.problem.level, 2);
    assert.ok(!s.solvedSync.ids.includes(pick.problem.id));
    s.rotation.current = pick.rotationNext;
  }
});

test('추천: 한 달 동안 유형이 골고루 돈다', () => {
  const s = fresh();
  const seen = {};
  let day = D0;
  for (let i = 0; i < 24; i += 1) {
    const now = at(day);
    prepare(s, now);
    const d = s.days[day];
    seen[d.topic] = (seen[d.topic] ?? 0) + 1;
    manualAction(s, { id: d.problemId, action: 'solved', at: now + 3600_000 });
    day = addDays(day, 1);
  }
  // 24일이면 가중치 합(24)만큼 → 모든 유형이 최소 1번, 비중 3인 유형은 3번
  for (const t of TOPICS) assert.ok(seen[t.key] >= 1, `${t.key} 미등장`);
  assert.equal(seen.impl, 3);
  assert.equal(seen.bfs, 3);
});

test('하루 흐름: 추천 → 못 풂 → N일 뒤 복습 → 해결', () => {
  const s = fresh({ retryIntervalDays: 3 });
  prepare(s, at(D0));
  const first = s.days[D0].problemId;
  assert.equal(s.records[first].status, 'pending');

  // 다음 날: 놓침 처리, 복습일 = D0 + 3
  prepare(s, at(addDays(D0, 1)));
  assert.equal(s.records[first].status, 'missed');
  assert.equal(s.records[first].missCount, 1);
  assert.equal(s.records[first].nextReviewOn, addDays(D0, 3));
  assert.deepEqual(s.days[addDays(D0, 1)].reviewIds, []);

  // D0+3: 복습으로 다시 추천된다
  prepare(s, at(addDays(D0, 2)));
  prepare(s, at(addDays(D0, 3)));
  assert.deepEqual(s.days[addDays(D0, 3)].reviewIds, [first]);
  assert.equal(s.records[first].status, 'pending');

  // 또 못 풀면 다시 3일 뒤
  prepare(s, at(addDays(D0, 4)));
  assert.equal(s.records[first].missCount, 2);
  assert.equal(s.records[first].nextReviewOn, addDays(D0, 6));

  // 복습 대기 중에 풀면(아무 날이든) 해결
  const r = recordSubmission(s, { id: first, passed: true, at: at(addDays(D0, 5)) });
  assert.equal(r.firstSolve, true);
  assert.equal(s.records[first].status, 'solved');
  assert.equal(s.records[first].nextReviewOn, null);
  assert.ok(!reviewQueue(s, addDays(D0, 6)).some((x) => x.id === first));
  // 그사이 매일 추천된 새 문제들(안 풂)도 각자 복습 대기열에 있다:
  // D0+2·D0+3 문제는 missed, D0+1 문제는 D0+4에 복습으로 올라와 pending, D0+4 문제는 아직 pending
  const queued = reviewQueue(s, addDays(D0, 6)).map((x) => x.id);
  assert.deepEqual(queued, [s.days[addDays(D0, 2)].problemId, s.days[addDays(D0, 3)].problemId]);
  assert.deepEqual(s.days[addDays(D0, 4)].reviewIds, [s.days[addDays(D0, 1)].problemId]);
});

test('크롬을 며칠 안 켜도 밀린 날짜를 한 번에 처리한다', () => {
  const s = fresh();
  prepare(s, at(D0));
  const id = s.days[D0].problemId;
  prepare(s, at(addDays(D0, 10)));
  assert.equal(s.records[id].status, 'pending'); // 복습 기한이 지나 오늘 바로 복습으로 올라온다
  assert.ok(s.days[addDays(D0, 10)].reviewIds.includes(id));
});

test('채점 감지: 오답은 해결 전까지만 센다', () => {
  const s = fresh();
  prepare(s, at(D0));
  const id = s.days[D0].problemId;
  recordOpen(s, { id, at: at(D0, '10:00') });
  recordSubmission(s, { id, passed: false, at: at(D0, '10:20') });
  recordSubmission(s, { id, passed: false, at: at(D0, '10:30') });
  const res = recordSubmission(s, { id, passed: true, at: at(D0, '10:40') });
  recordSubmission(s, { id, passed: false, at: at(D0, '11:00') }); // 푼 뒤 다른 풀이 시도
  assert.equal(res.firstSolve, true);
  assert.equal(s.records[id].wrong, 2);
  assert.equal(s.records[id].submits, 4);
  assert.equal(s.records[id].solvedOn, D0);
  assert.equal(s.records[id].solvedAt - s.records[id].firstOpenedAt, 40 * 60_000);
});

test('추천 안 받은 문제를 스스로 풀어도 기록된다', () => {
  const s = fresh();
  prepare(s, at(D0));
  recordOpen(s, { id: 42583, at: at(D0, '13:00') });
  recordSubmission(s, { id: 42583, passed: true, at: at(D0, '13:30') });
  assert.equal(s.records[42583].origin, 'self');
  assert.equal(s.records[42583].status, 'solved');
  assert.equal(s.records[42583].firstOpenedAt, at(D0, '13:00'));
  // 카탈로그에 없는 문제도 페이지에서 받은 제목으로 기록
  recordSubmission(s, { id: 999999, passed: false, title: '새 문제', level: 2, at: at(D0, '14:00') });
  assert.equal(s.records[999999].title, '새 문제');
});

test('동기화: 해결 목록을 합치고, 진행 중인 추천 문제를 해결로 바꾼다', () => {
  const s = fresh();
  prepare(s, at(D0));
  const id = s.days[D0].problemId;
  recordOpen(s, { id, at: at(D0, '10:00') });
  const out = applySync(s, [{ id }, { id: 1845 }, { id: 123456789, title: '카탈로그 밖', level: 1, part: '연습문제' }], at(D0, '12:00'));
  assert.equal(out.added, 3);
  assert.deepEqual(out.newlySolved, [id]);
  assert.equal(s.records[id].solvedVia, 'sync');
  assert.equal(s.solvedSync.meta[123456789].title, '카탈로그 밖');
  // 해결은 되돌아가지 않는다: 빈 목록이 와도 유지
  applySync(s, [], at(D0, '13:00'));
  assert.ok(s.solvedSync.ids.includes(1845));
});

test('첫 동기화에서 오늘의 문제가 이미 푼 문제로 밝혀지면 다른 문제로 바꾼다', () => {
  const s = fresh();
  prepare(s, at(D0));
  const id = s.days[D0].problemId;
  const list = [{ id }];
  const stale = staleDailyIds(s, list, at(D0, '10:05'));
  assert.deepEqual(stale, [id]);
  applySync(s, list, at(D0, '10:05'), { skipIds: stale });
  const res = rerollToday(s, at(D0, '10:05'), { force: true });
  assert.equal(res.ok, true);
  assert.notEqual(s.days[D0].problemId, id);
  assert.equal(s.records[id], undefined);
  assert.equal(s.days[D0].rerolls, 0);
});

test('다른 문제로 바꾸기: 같은 유형, 하루 3번까지', () => {
  const s = fresh();
  prepare(s, at(D0));
  const topic = s.days[D0].topic;
  const seen = new Set([s.days[D0].problemId]);
  for (let i = 0; i < 3; i += 1) {
    const res = rerollToday(s, at(D0, '11:00'));
    assert.equal(res.ok, true);
    assert.equal(s.days[D0].topic, topic);
    assert.ok(getProblem(s.days[D0].problemId).topics.includes(topic));
    assert.ok(!seen.has(s.days[D0].problemId));
    seen.add(s.days[D0].problemId);
  }
  assert.equal(rerollToday(s, at(D0, '11:00')).reason, 'limit');
});

test('직접 체크: 풀었어요 / 되돌리기 / 그만 보기', () => {
  const s = fresh();
  prepare(s, at(D0));
  const id = s.days[D0].problemId;
  manualAction(s, { id, action: 'solved', at: at(D0, '20:00') });
  assert.equal(s.records[id].status, 'solved');
  manualAction(s, { id, action: 'unsolve', at: at(D0, '20:01') });
  assert.equal(s.records[id].status, 'pending');
  manualAction(s, { id, action: 'drop', at: at(D0, '20:02') });
  assert.equal(s.records[id].status, 'dropped');
  prepare(s, at(addDays(D0, 5)));
  assert.equal(reviewQueue(s, addDays(D0, 5)).length, 0);
});

test('난이도 계단: 깔끔하게 2번 풀면 +1, 놓치면 -1', () => {
  const s = fresh({ minLevel: 1, maxLevel: 4, startLevel: 2 });
  let day = D0;
  const levels = [];
  // 같은 유형만 나오게
  updateSettings(s, { topics: ['hash'] });
  for (let i = 0; i < 4; i += 1) {
    prepare(s, at(day));
    const id = s.days[day].problemId;
    levels.push(s.days[day].targetLevel);
    recordSubmission(s, { id, passed: true, at: at(day, '12:00') });
    day = addDays(day, 1);
  }
  assert.deepEqual(levels, [2, 2, 3, 3]);
  prepare(s, at(day));
  recordOpen(s, { id: s.days[day].problemId, at: at(day, '20:00') }); // 열어봤지만 못 푼다
  prepare(s, at(addDays(day, 1)));
  assert.equal(s.topicLevel.hash.level, 3); // 4번 깔끔 해결로 4가 됐다가 놓쳐서 3
});

test('안 열어보고 놓친 날은 약점·난이도에 반영하지 않는다', () => {
  const s = fresh({ retryIntervalDays: 2 });
  updateSettings(s, { topics: ['dp'] });
  prepare(s, at(D0));
  const id = s.days[D0].problemId;
  prepare(s, at(addDays(D0, 1))); // 바빠서 안 열어봄
  assert.equal(s.records[id].status, 'missed');
  assert.equal(s.records[id].triedMisses, 0);
  assert.equal(s.topicLevel.dp, undefined);
  assert.equal(computeTopicStats(s, addDays(D0, 1)).stats.dp.count, 0);
  // 복습 날 열어보고 또 못 풀면 그때부터 근거가 된다
  prepare(s, at(addDays(D0, 2)));
  assert.ok(s.days[addDays(D0, 2)].reviewIds.includes(id));
  recordOpen(s, { id, at: at(addDays(D0, 2), '21:00') });
  recordSubmission(s, { id, passed: false, at: at(addDays(D0, 2), '21:30') });
  prepare(s, at(addDays(D0, 3)));
  assert.equal(s.records[id].missCount, 2);
  assert.equal(s.records[id].triedMisses, 1);
  assert.equal(computeTopicStats(s, addDays(D0, 3)).stats.dp.unsolved >= 1, true);
});

test('약점 분석: 못 푼 유형이 위로 오고, 데이터가 적으면 순위에서 뺀다', () => {
  const s = fresh();
  const put = (id, status, extra = {}) => {
    const p = getProblem(id);
    s.records[id] = {
      id, title: p.title, level: p.level, topics: p.topics, status, recommendedOn: [D0], missCount: 0, wrong: 0, submits: 1,
      solvedAt: null, firstOpenedAt: null, ...extra,
    };
  };
  // DP: 3문제 모두 시도했지만 못 풂
  put(42895, 'missed', { missCount: 1, triedMisses: 1 });
  put(43105, 'missed', { missCount: 2, triedMisses: 2 });
  put(42898, 'dropped', { missCount: 1, triedMisses: 1 });
  // 해시: 3문제 깔끔 해결
  put(1845, 'solved', { solvedAt: 1 });
  put(42576, 'solved', { solvedAt: 1 });
  put(42577, 'solved', { solvedAt: 1, wrong: 1 });
  // 그리디: 1문제(근거 부족)
  put(42862, 'missed', { missCount: 1, triedMisses: 1 });
  const res = computeTopicStats(s, addDays(D0, 1));
  const ranked = rankWeakTopics(res);
  assert.equal(ranked[0].key, 'dp');
  assert.ok(res.stats.dp.score > res.stats.hash.score);
  assert.ok(!ranked.some((st) => st.key === 'greedy'));
  const boosts = weaknessBoosts(s, addDays(D0, 1));
  assert.ok(boosts.dp > 0.2, `dp boost ${boosts.dp}`);
  assert.equal(boosts.hash, 0);
  // 약한 유형은 추천 비중이 커진다
  const w = topicWeights(s.settings, boosts);
  assert.ok(w.dp > 2);
});

test('알림 계획: 정한 시각마다 한 번, 풀면 그만, 밀린 시각은 한 번에', () => {
  const s = fresh(); // 기본 10·14·17·20시
  prepare(s, at(D0, '08:00'));
  assert.equal(notificationPlan(s, at(D0, '09:59')).slots.length, 0);
  let p = notificationPlan(s, at(D0, '10:00'));
  assert.deepEqual(p.slots, ['10:00']);
  assert.equal(p.send, true);
  assert.equal(p.kind, 'daily');
  markSlots(s, D0, p.slots, { notified: true, at: at(D0, '10:00') });
  assert.equal(notificationPlan(s, at(D0, '13:00')).slots.length, 0);
  p = notificationPlan(s, at(D0, '14:05'));
  assert.equal(p.kind, 'remind');
  markSlots(s, D0, p.slots, { notified: true });
  manualAction(s, { id: s.days[D0].problemId, action: 'solved', at: at(D0, '15:00') });
  p = notificationPlan(s, at(D0, '17:00'));
  assert.deepEqual(p.slots, ['17:00']);
  assert.equal(p.send, false, '풀었으면 시각만 소진');

  // 크롬을 오후 6시에 처음 켜면 지난 세 시각을 한 번에 처리하고 알림은 한 번
  const late = fresh();
  prepare(late, at(D0, '18:00'));
  const q = notificationPlan(late, at(D0, '18:00'));
  assert.deepEqual(q.slots, ['10:00', '14:00', '17:00']);
  assert.equal(q.send, true);
  assert.equal(q.kind, 'daily');

  // 오늘은 그만 알림
  const m = fresh();
  prepare(m, at(D0, '09:00'));
  muteToday(m, at(D0, '09:30'));
  assert.equal(notificationPlan(m, at(D0, '10:00')).send, false);

  // 알림 시각 직접 설정: 형식 맞추기·중복 제거·정렬
  updateSettings(m, { notifyTimes: ['21:30', '7:05', '21:30', 'x'] });
  assert.deepEqual(m.settings.notifyTimes, ['07:05', '21:30']);
});

test('통계 요약: 연속 해결일', () => {
  const s = fresh();
  let day = D0;
  for (let i = 0; i < 3; i += 1) {
    prepare(s, at(day));
    recordSubmission(s, { id: s.days[day].problemId, passed: true, at: at(day, '12:00') });
    day = addDays(day, 1);
  }
  prepare(s, at(day)); // 오늘은 아직 안 풂 → 어제까지 3일 연속
  const sum = summarize(s, day);
  assert.equal(sum.streak, 3);
  assert.equal(sum.longest, 3);
  assert.equal(sum.solvedRecommended, 3);
});

test('저장소: 동시 쓰기가 유실되지 않는다', async () => {
  const store = createStore(memoryArea());
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.update((s) => {
        recordSubmission(s, { id: 1000 + i, passed: false, at: at(D0) });
      }),
    ),
  );
  const s = await store.read();
  assert.equal(Object.keys(s.records).length, 20);
});

test('설정 정규화·마이그레이션', () => {
  const s = normalizeSettings({ minLevel: 4, maxLevel: 2, startLevel: 9, notifyTimes: ['7:30', '21:00', '7:30'], topics: ['dp', 'nope'], retryIntervalDays: 0 });
  assert.equal(s.minLevel, 2);
  assert.equal(s.maxLevel, 4);
  assert.equal(s.startLevel, 4);
  assert.deepEqual(s.notifyTimes, ['07:30', '21:00']);
  assert.deepEqual(normalizeSettings({}).notifyTimes, ['10:00', '14:00', '17:00', '20:00']);
  assert.deepEqual(s.topics, ['dp']);
  assert.equal(s.retryIntervalDays, 1);
  const m = migrate({ records: { 1: { id: 1 } }, days: {}, settings: {} });
  assert.equal(m.schemaVersion, 1);
  assert.ok(Array.isArray(m.events));
  assert.ok(ensureDay(m, D0, at(D0)).created);
  assert.equal(processRollover(m, addDays(D0, 1)).length, 1);
});
