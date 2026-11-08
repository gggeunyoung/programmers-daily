// 백그라운드 서비스를 가짜 chrome API·가짜 시계로 돌려 하루 흐름(알림 시각·풀면 중단·자정·동기화)을 검증한다.
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
      getAll: async () => Object.keys(calls.alarms).map((name) => ({ name })),
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

async function at(clock, service, key, hhmm) {
  clock.t = atTime(key, hhmm);
  await service.onAlarm({ name: `slot|${hhmm}` });
}

test('하루 네 번(10·14·17·20시) 같은 문제로 알리고, 풀면 남은 시각엔 안 보낸다', async () => {
  const { clock, calls, store, service } = setup();
  await service.onInstalled({ reason: 'install' });
  for (const t of ['10:00', '14:00', '17:00', '20:00']) assert.ok(calls.alarms[`slot|${t}`], `${t} 알람`);
  assert.ok(calls.alarms.midnight && calls.alarms.tick);
  assert.equal(calls.notes.length, 0, '10시 전에는 알림 없음');
  assert.ok(calls.tabs[0].endsWith('#welcome'));
  assert.equal(calls.badge, '1');

  await at(clock, service, D0, '10:00');
  assert.equal(calls.notes.length, 1);
  const first = calls.notes[0];
  assert.match(first.title, /^오늘의 코테/);
  await service.onAlarm({ name: 'tick' }); // 같은 시각은 두 번 보내지 않는다
  assert.equal(calls.notes.length, 1);

  await at(clock, service, D0, '14:00');
  assert.equal(calls.notes.length, 2);
  assert.equal(calls.notes[1].id, first.id, '같은 날은 같은 알림 자리(같은 문제)를 새로 고친다');
  assert.equal(calls.notes[1].title, '오늘 문제, 아직이에요');

  const s = await store.read();
  const id = s.days[D0].problemId;
  assert.equal(first.message, s.records[id].title, '알림 문제 = 오늘의 문제');
  assert.ok(calls.notes[1].message.startsWith(s.records[id].title));

  clock.t = atTime(D0, '15:00');
  const res = await service.handleMessage({ type: 'submission', id, passed: true });
  assert.equal(res.role, 'daily');
  assert.equal(calls.badge, '✓');
  await at(clock, service, D0, '17:00');
  await at(clock, service, D0, '20:00');
  assert.equal(calls.notes.length, 2, '풀었으면 17·20시 알림 없음');
  assert.equal((await store.read()).days[D0].problemId, id, '하루 동안 문제는 그대로');
});

test('오후에 설치하면 지난 시각은 알림 없이 넘기고 다음 시각부터 보낸다', async () => {
  const { clock, calls, service } = setup({ startAt: atTime(D0, '15:00') });
  await service.onInstalled({ reason: 'install' });
  assert.equal(calls.notes.length, 0);
  await at(clock, service, D0, '17:00');
  assert.equal(calls.notes.length, 1);
  assert.match(calls.notes[0].title, /^오늘의 코테/);
});

test('크롬을 늦게 켜면 밀린 시각은 한 번에 처리하고 알림은 한 번만', async () => {
  const { clock, calls, service } = setup();
  await service.onInstalled({ reason: 'install' });
  clock.t = atTime(D0, '18:30');
  await service.onStartup();
  assert.equal(calls.notes.length, 1);
  await service.onAlarm({ name: 'tick' });
  assert.equal(calls.notes.length, 1);
});

test("알림 버튼: '문제 풀러 가기'는 문제 탭, '오늘은 그만 알림'은 남은 시각 알림 중단", async () => {
  const { clock, calls, service } = setup();
  await service.onInstalled({ reason: 'install' });
  await at(clock, service, D0, '10:00');
  const nid = calls.notes[0].id;
  await service.onNotificationButton(nid, 0);
  assert.ok(calls.tabs.at(-1).includes('/learn/courses/30/lessons/'));
  await service.onNotificationButton(nid, 1);
  await at(clock, service, D0, '14:00');
  await at(clock, service, D0, '17:00');
  assert.equal(calls.notes.length, 1);
  // 다음 날은 다시 온다
  await at(clock, service, addDays(D0, 1), '10:00');
  assert.equal(calls.notes.length, 2);
});

test('알림 시각을 바꾸면 알람도 바뀐다', async () => {
  const { calls, service } = setup();
  await service.onInstalled({ reason: 'install' });
  await service.handleMessage({ type: 'updateSettings', patch: { notifyTimes: ['08:30', '22:00'] } });
  assert.ok(calls.alarms['slot|08:30'] && calls.alarms['slot|22:00']);
  assert.equal(calls.alarms['slot|10:00'], undefined);
});

test('자정이 지나면 못 푼 문제는 놓침 → 3일 뒤 알림에 "다시 도전"이 함께 온다', async () => {
  const { clock, calls, store, service } = setup();
  await service.onInstalled({ reason: 'install' });
  const first = (await store.read()).days[D0].problemId;
  await service.handleMessage({ type: 'opened', id: first }); // 열어봤지만 못 풂

  clock.t = atTime(addDays(D0, 1), '00:01');
  await service.onAlarm({ name: 'midnight' });
  let s = await store.read();
  assert.equal(s.records[first].status, 'missed');
  assert.equal(s.records[first].nextReviewOn, addDays(D0, 3));

  calls.notes.length = 0;
  await at(clock, service, addDays(D0, 3), '10:00');
  s = await store.read();
  assert.ok(s.days[addDays(D0, 3)].reviewIds.includes(first));
  assert.equal(calls.notes.length, 1, '복습이 있어도 알림은 한 장');
  assert.match(calls.notes[0].contextMessage, /다시 도전 1문제/);
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

test('첫 동기화가 오늘의 문제를 이미 푼 문제로 밝히면: 알림 전엔 바꾸고, 알림 뒤엔 그대로 둔다', async () => {
  {
    const { store, service } = setup({ solved: [], signedIn: false });
    await service.onInstalled({ reason: 'install' });
    const before = (await store.read()).days[D0].problemId;
    const res = await service.handleMessage({ type: 'syncResult', solved: [{ id: before }, { id: 1845 }], signedIn: true });
    assert.equal(res.replaced, true);
    assert.notEqual((await store.read()).days[D0].problemId, before);
  }
  {
    const { clock, store, service } = setup({ solved: [], signedIn: false });
    await service.onInstalled({ reason: 'install' });
    await at(clock, service, D0, '10:00'); // 알림으로 이미 보여 줌
    const before = (await store.read()).days[D0].problemId;
    const res = await service.handleMessage({ type: 'syncResult', solved: [{ id: before }], signedIn: true });
    assert.equal(res.replaced, false);
    assert.equal((await store.read()).days[D0].problemId, before, '알림으로 보여 준 문제는 바꾸지 않는다');
  }
});

test('설치 때 로그인 전이었으면 30초 뒤부터 바로 다시 시도한다(로그인 직후 반영)', async () => {
  const { clock, store, service } = setup({ solved: [], signedIn: false });
  await service.onInstalled({ reason: 'install' });
  assert.equal((await store.read()).solvedSync.ok, false);
  clock.t += 10_000;
  assert.equal((await service.handleMessage({ type: 'syncStatus' })).due, false);
  clock.t += 30_000;
  assert.equal((await service.handleMessage({ type: 'syncStatus' })).due, true);
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
