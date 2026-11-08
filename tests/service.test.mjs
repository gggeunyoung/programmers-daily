// 백그라운드 서비스를 가짜 chrome API·가짜 시계로 돌려 하루 흐름(알림·리마인더·자정·스누즈·동기화)을 검증한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createService } from '../src/background/service.js';
import { addDays, atTime } from '../src/lib/dates.js';
import { createStore, memoryArea } from '../src/lib/store.js';

const D0 = '2026-11-09';

function setup({ solved = [], signedIn = true, startAt = atTime(D0, '08:00') } = {}) {
  const clock = { t: startAt };
  const calls = { notes: [], cleared: [], alarms: {}, badge: '', tabs: [] };
  const chrome = {
    runtime: { getURL: (p) => `chrome-extension://test/${p}` },
    alarms: {
      create: async (name, info) => {
        calls.alarms[name] = info;
      },
      clear: async (name) => delete calls.alarms[name],
    },
    notifications: {
      create: async (id, opts) => {
        calls.notes.push({ id, ...opts });
        return id;
      },
      clear: async (id) => {
        calls.cleared.push(id);
        return true;
      },
    },
    action: {
      setBadgeText: async ({ text }) => {
        calls.badge = text;
      },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    tabs: {
      create: async ({ url }) => {
        calls.tabs.push(url);
      },
    },
  };
  const fetchImpl = async (url) => {
    if (url.includes('/api/v2/school/challenges/')) {
      return {
        ok: true,
        json: async () => ({
          totalPages: solved.length ? 1 : 0,
          totalEntries: solved.length,
          result: solved.map((id) => ({ id, title: `문제${id}`, level: 2, partTitle: '연습문제', status: 'solved' })),
        }),
      };
    }
    return { ok: true, text: async () => `<div data-user-signed-in="${signedIn}"></div>` };
  };
  const store = createStore(memoryArea());
  const service = createService({ store, chrome, now: () => clock.t, fetchImpl });
  return { clock, calls, store, service };
}

const kinds = (calls) => calls.notes.map((n) => n.id.split('|')[0]);

test('설치 → 9시 알림 → 21시 리마인더 → 정답 감지 후 배지 ✓', async () => {
  const { clock, calls, store, service } = setup();
  await service.onInstalled({ reason: 'install' });
  assert.ok(calls.alarms.daily && calls.alarms.remind && calls.alarms.midnight && calls.alarms.tick);
  assert.equal(calls.notes.length, 0, '9시 전에는 알림 없음');
  assert.ok(calls.tabs[0].endsWith('#welcome'));
  assert.equal(calls.badge, '1');

  clock.t = atTime(D0, '09:00');
  await service.onAlarm({ name: 'daily' });
  assert.deepEqual(kinds(calls), ['daily']);
  await service.onAlarm({ name: 'tick' }); // 같은 날 두 번 보내지 않는다
  assert.equal(calls.notes.length, 1);

  clock.t = atTime(D0, '21:00');
  await service.onAlarm({ name: 'remind' });
  assert.deepEqual(kinds(calls), ['daily', 'remind']);

  const s = await store.read();
  const id = s.days[D0].problemId;
  const res = await service.handleMessage({ type: 'submission', id, passed: true });
  assert.equal(res.role, 'daily');
  assert.equal(res.firstSolve, true);
  assert.equal(calls.badge, '✓');
});

test('이미 풀었으면 저녁 리마인더를 보내지 않는다', async () => {
  const { clock, calls, store, service } = setup();
  await service.onInstalled({ reason: 'install' });
  const id = (await store.read()).days[D0].problemId;
  clock.t = atTime(D0, '12:00');
  await service.handleMessage({ type: 'manual', id, action: 'solved' });
  clock.t = atTime(D0, '21:00');
  await service.onAlarm({ name: 'remind' });
  assert.ok(!kinds(calls).includes('remind'));
});

test('자정이 지나면 못 푼 문제는 놓침 → 3일 뒤 복습 알림', async () => {
  const { clock, calls, store, service } = setup();
  await service.onInstalled({ reason: 'install' });
  const first = (await store.read()).days[D0].problemId;
  await service.handleMessage({ type: 'opened', id: first }); // 열어봤지만 못 풂

  clock.t = atTime(addDays(D0, 1), '00:01');
  await service.onAlarm({ name: 'midnight' });
  let s = await store.read();
  assert.equal(s.records[first].status, 'missed');
  assert.equal(s.records[first].nextReviewOn, addDays(D0, 3));

  clock.t = atTime(addDays(D0, 3), '09:00');
  calls.notes.length = 0;
  await service.onAlarm({ name: 'daily' });
  s = await store.read();
  assert.ok(s.days[addDays(D0, 3)].reviewIds.includes(first));
  assert.deepEqual(kinds(calls).sort(), ['daily', 'review']);
  const review = calls.notes.find((n) => n.id.startsWith('review|'));
  assert.ok(review.message.includes(s.records[first].title));
});

test('알림 버튼: 풀러 가기는 문제 탭, 1시간 뒤는 스누즈 알람', async () => {
  const { clock, calls, service } = setup();
  await service.onInstalled({ reason: 'install' });
  clock.t = atTime(D0, '09:00');
  await service.onAlarm({ name: 'daily' });
  const nid = calls.notes[0].id;
  await service.onNotificationButton(nid, 0);
  assert.ok(calls.tabs.at(-1).includes('/learn/courses/30/lessons/'));
  await service.onNotificationButton(nid, 1);
  const snooze = Object.keys(calls.alarms).find((k) => k.startsWith('snooze|'));
  assert.ok(snooze);
  clock.t = atTime(D0, '10:00');
  calls.notes.length = 0;
  await service.onAlarm({ name: snooze });
  assert.equal(calls.notes.length, 1);
});

test('동기화: 설치 때 이미 푼 문제는 추천하지 않고, 해결 수를 기록한다', async () => {
  const solved = [1845, 42576, 42577, 42578, 42586];
  const { store, service } = setup({ solved });
  await service.onInstalled({ reason: 'install' });
  const s = await store.read();
  assert.equal(s.solvedSync.ok, true);
  assert.equal(s.solvedSync.ids.length, 5);
  assert.ok(!solved.includes(s.days[D0].problemId));
});

test('동기화: 로그인 안 돼 있으면 안내 메시지를 남긴다', async () => {
  const { store, service } = setup({ solved: [], signedIn: false });
  await service.onInstalled({ reason: 'install' });
  const s = await store.read();
  assert.equal(s.solvedSync.ok, false);
  assert.equal(s.solvedSync.signedIn, false);
  assert.match(s.solvedSync.message, /로그인/);
});

test('페이지에서 온 동기화가 오늘의 문제를 이미 푼 문제로 밝히면 자동으로 바꾼다', async () => {
  const { store, service } = setup({ solved: [], signedIn: false });
  await service.onInstalled({ reason: 'install' });
  const before = (await store.read()).days[D0].problemId;
  const res = await service.handleMessage({ type: 'syncResult', solved: [{ id: before }, { id: 1845 }], signedIn: true });
  assert.equal(res.replaced, true);
  const s = await store.read();
  assert.notEqual(s.days[D0].problemId, before);
  assert.equal(s.solvedSync.ok, true);
});

test('설치 때 로그인 전이었으면 30초 뒤부터 바로 다시 시도한다(로그인 직후 반영)', async () => {
  const { clock, store, service } = setup({ solved: [], signedIn: false });
  await service.onInstalled({ reason: 'install' });
  assert.equal((await store.read()).solvedSync.ok, false);
  clock.t += 10_000;
  assert.equal((await service.handleMessage({ type: 'syncStatus' })).due, false);
  clock.t += 30_000;
  assert.equal((await service.handleMessage({ type: 'syncStatus' })).due, true);
  // 페이지(로그인 세션)에서 가져온 결과가 들어오면 성공 상태로 바뀌고 6시간 주기로 돌아간다
  await service.handleMessage({ type: 'syncResult', solved: [{ id: 1845 }], signedIn: true });
  clock.t += 60_000;
  assert.equal((await service.handleMessage({ type: 'syncStatus' })).due, false);
});

test('자동 동기화 주기: 6시간 안에는 다시 하지 않는다', async () => {
  const { clock, service } = setup({ solved: [1845] });
  await service.onInstalled({ reason: 'install' });
  clock.t += 3600_000;
  assert.equal((await service.syncSolved()).skipped, true);
  clock.t += 6 * 3600_000;
  assert.notEqual((await service.syncSolved()).skipped, true);
});
