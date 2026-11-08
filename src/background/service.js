// 백그라운드 서비스: 알람·알림·메시지 처리·동기화.
// chrome API 와 저장소를 주입받아 만들기 때문에 서비스 워커·개발용 하네스에서 같은 코드를 쓴다.
import { summarize } from '../lib/analytics.js';
import { dateKey, nextOccurrence } from '../lib/dates.js';
import {
  applySync,
  compact,
  ensureDay,
  manualAction,
  notificationPlan,
  prepare,
  processRollover,
  recordOpen,
  recordSubmission,
  rerollToday,
  staleDailyIds,
  updateSettings,
} from '../lib/engine.js';
import { checkSignedIn, fetchSolvedList, problemUrl } from '../lib/programmers.js';
import { createInitialState, looksLikeState } from '../lib/state.js';
import { topicName } from '../lib/topics.js';

export const SYNC_STALE_MS = 6 * 3600_000; // 자동 동기화 주기
export const SYNC_RETRY_GAP_MS = 10 * 60_000; // 성공한 뒤 다음 시도까지 최소 간격
export const SYNC_EAGER_GAP_MS = 30_000; // 아직 성공 못 했을 때(로그인 전 등) 재시도 간격
const SNOOZE_MINUTES = 60;

export function createService({ store, chrome, now = () => Date.now(), fetchImpl = (...a) => fetch(...a) }) {
  const iconUrl = () => chrome.runtime.getURL('icons/icon128.png');
  const dashboardUrl = (hash = '') => chrome.runtime.getURL(`src/dashboard/dashboard.html${hash}`);

  // ── 알람 ───────────────────────────────────────────────
  async function scheduleAlarms() {
    const { settings } = await store.read();
    const t = now();
    await chrome.alarms.create('daily', { when: nextOccurrence(settings.notifyTime, t) });
    if (settings.reminderEnabled) await chrome.alarms.create('remind', { when: nextOccurrence(settings.reminderTime, t) });
    else await chrome.alarms.clear('remind');
    await chrome.alarms.create('midnight', { when: nextOccurrence('00:00', t) + 60_000 });
    // 컴퓨터가 잠들어 있어 시각 알람을 놓쳐도 30분 안에는 따라잡는 안전망
    await chrome.alarms.create('tick', { periodInMinutes: 30 });
  }

  async function onAlarm(alarm) {
    const name = alarm?.name ?? '';
    if (name.startsWith('snooze|')) return onSnooze(name);
    await tick(name);
    if (name !== 'tick') await scheduleAlarms();
  }

  // ── 주기 작업 ───────────────────────────────────────────
  /** 날짜 넘김·오늘 추천 보장·알림·배지·자동 동기화 */
  async function tick(reason = 'tick') {
    const t = now();
    const { plan, info } = await store.update((s) => {
      const today = prepare(s, t);
      compact(s, today);
      s.meta.lastTickAt = t;
      const p = notificationPlan(s, t);
      const day = s.days[today];
      if (p.consume) day.notifiedAt = t;
      if (p.suppressRemind || p.remind) day.remindedAt = t;
      return { plan: p, info: notificationInfo(s, today) };
    });
    await deliver(plan, info);
    await refreshBadge();
    if (reason !== 'install') await syncSolved().catch(() => {});
    return plan;
  }

  function notificationInfo(s, today) {
    const day = s.days[today];
    const rec = day?.problemId ? s.records[day.problemId] : null;
    const reviews = (day?.reviewIds ?? []).map((id) => s.records[id]).filter((r) => r && r.status === 'pending');
    return {
      today,
      daily: rec
        ? { id: rec.id, title: rec.title, level: rec.level, topic: day.topic, part: rec.part, pending: rec.status === 'pending' }
        : null,
      reviews: reviews.map((r) => ({ id: r.id, title: r.title, level: r.level, topic: r.topics?.[0], missCount: r.missCount })),
      streak: summarize(s, today).streak,
      retryDays: s.settings.retryIntervalDays,
    };
  }

  // ── 알림 ───────────────────────────────────────────────
  async function show(id, opts) {
    try {
      await chrome.notifications.clear(id);
      await chrome.notifications.create(id, { type: 'basic', iconUrl: iconUrl(), priority: 2, ...opts });
    } catch (e) {
      console.warn('[1일1코] 알림 실패', e);
    }
  }

  function dailyNotification(info, kind) {
    const d = info.daily;
    const lv = d.level ? ` Lv.${d.level}` : '';
    if (kind === 'remind') {
      return {
        title: '오늘 문제, 아직이에요',
        message: `${d.title} · ${topicName(d.topic)}${lv}`,
        contextMessage: `자기 전에 한 문제! 못 풀면 ${info.retryDays}일 뒤 다시 알려드려요`,
        buttons: [{ title: '지금 풀러 가기' }, { title: '1시간 뒤 다시 알림' }],
      };
    }
    const extra = info.reviews.length ? ` · 복습 ${info.reviews.length}문제 대기` : '';
    return {
      title: `오늘의 코테 · ${topicName(d.topic)}${lv}`,
      message: d.title,
      contextMessage: (info.streak ? `🔥 ${info.streak}일 연속 해결 중` : d.part || '하루 한 문제') + extra,
      buttons: [{ title: '문제 풀러 가기' }, { title: '1시간 뒤 다시 알림' }],
    };
  }

  function reviewNotification(info) {
    const [first, ...rest] = info.reviews;
    const more = rest.length ? ` 외 ${rest.length}문제` : '';
    return {
      title: `다시 도전! 지난번에 못 푼 문제${more ? '들' : ''}`,
      message: `${first.title}${first.level ? ` (Lv.${first.level})` : ''}${more}`,
      contextMessage: `${first.missCount}번 놓친 문제예요 · 풀면 복습 목록에서 빠져요`,
      buttons: [{ title: '다시 풀기' }, { title: '복습 목록 보기' }],
    };
  }

  async function deliver(plan, info) {
    const tasks = [];
    if (plan.daily && info.daily?.pending) tasks.push(show(`daily|${info.today}|${info.daily.id}`, dailyNotification(info, 'daily')));
    if (plan.review && info.reviews.length) tasks.push(show(`review|${info.today}|${info.reviews[0].id}`, reviewNotification(info)));
    if (plan.remind) {
      if (info.daily?.pending) tasks.push(show(`remind|${info.today}|${info.daily.id}`, dailyNotification(info, 'remind')));
      else if (info.reviews.length) tasks.push(show(`remind|${info.today}|${info.reviews[0].id}`, reviewNotification(info)));
    }
    await Promise.all(tasks);
  }

  async function openProblem(id) {
    const { settings } = await store.read();
    await chrome.tabs.create({ url: problemUrl(id, settings.language) });
  }

  function parseNotificationId(nid) {
    const [kind, date, id] = String(nid).split('|');
    return { kind, date, id: Number(id) };
  }

  async function onNotificationClicked(nid) {
    const { kind, id } = parseNotificationId(nid);
    await chrome.notifications.clear(nid);
    if (kind === 'test' || !id) await chrome.tabs.create({ url: dashboardUrl() });
    else await openProblem(id);
  }

  async function onNotificationButton(nid, index) {
    const { kind, date, id } = parseNotificationId(nid);
    await chrome.notifications.clear(nid);
    if (index === 0) {
      if (id) await openProblem(id);
      return;
    }
    if (kind === 'review') {
      await chrome.tabs.create({ url: dashboardUrl('#history') });
      return;
    }
    // 1시간 뒤 다시 알림
    await chrome.alarms.create(`snooze|${kind}|${date}|${id}`, { delayInMinutes: SNOOZE_MINUTES });
  }

  async function onSnooze(name) {
    const [, kind, date, idStr] = name.split('|');
    const id = Number(idStr);
    const s = await store.read();
    const today = dateKey(now());
    if (date !== today || s.records[id]?.status !== 'pending') return; // 그새 풀었거나 날이 바뀜
    const info = notificationInfo(s, today);
    if (info.daily?.id === id) await show(`remind|${today}|${id}`, dailyNotification(info, kind === 'daily' ? 'daily' : 'remind'));
    else if (info.reviews.some((r) => r.id === id)) await show(`review|${today}|${id}`, reviewNotification(info));
  }

  async function testNotification() {
    const s = await store.read();
    const info = notificationInfo(s, dateKey(now()));
    await show(`test|${info.today}|${info.daily?.id ?? 0}`, {
      title: '알림 테스트 — 잘 보이나요?',
      message: info.daily ? `오늘의 문제: ${info.daily.title}` : '오늘의 문제를 준비 중이에요',
      contextMessage: '매일 설정한 시각에 이런 알림이 와요',
    });
  }

  // ── 배지 ───────────────────────────────────────────────
  async function refreshBadge() {
    const s = await store.read();
    const day = s.days[dateKey(now())];
    const ids = day ? [day.problemId, ...(day.reviewIds ?? [])].filter(Boolean) : [];
    const pending = ids.filter((id) => s.records[id]?.status === 'pending').length;
    const dailyDone = day?.problemId && s.records[day.problemId]?.status === 'solved';
    try {
      if (pending) {
        await chrome.action.setBadgeText({ text: String(pending) });
        await chrome.action.setBadgeBackgroundColor({ color: '#E8590C' });
        await chrome.action.setTitle({ title: `1일1코 · 오늘 풀 문제 ${pending}개` });
      } else if (dailyDone) {
        await chrome.action.setBadgeText({ text: '✓' });
        await chrome.action.setBadgeBackgroundColor({ color: '#2F9E44' });
        await chrome.action.setTitle({ title: '1일1코 · 오늘의 문제 해결!' });
      } else {
        await chrome.action.setBadgeText({ text: '' });
        await chrome.action.setTitle({ title: '1일1코' });
      }
    } catch (e) {
      console.warn('[1일1코] 배지 갱신 실패', e);
    }
  }

  // ── 프로그래머스 동기화 ──────────────────────────────────
  function isSyncDue(s, t) {
    const ss = s.solvedSync;
    if (!s.settings.autoSync) return false;
    // 아직 한 번도 성공하지 못했으면(설치 때 로그인 전이었다 등) 짧은 간격으로 다시 시도해
    // 로그인하고 프로그래머스 페이지를 여는 즉시 해결 기록을 가져온다
    const ok = ss.ok === true;
    const gap = ok ? SYNC_RETRY_GAP_MS : SYNC_EAGER_GAP_MS;
    if (ss.attemptAt && t - ss.attemptAt < gap) return false;
    return !ok || !ss.at || t - ss.at >= SYNC_STALE_MS;
  }

  /** 해결 목록 반영. 페이지(content script)와 백그라운드 양쪽에서 온 결과를 같은 규칙으로 처리 */
  async function applySyncResult({ solved = [], signedIn = null, via = 'background' }) {
    const t = now();
    const out = await store.update((s) => {
      const today = dateKey(t);
      processRollover(s, today, t);
      const ss = s.solvedSync;
      let res = { added: 0, newlySolved: [], replaced: false, total: (ss.ids ?? []).length };
      if (!solved.length) {
        if (signedIn === true) {
          Object.assign(ss, { at: t, ok: true, signedIn: true, via, message: '아직 해결한 문제가 없어요' });
        } else if (!(ss.ids ?? []).length) {
          Object.assign(ss, {
            ok: false,
            signedIn,
            message: '프로그래머스에 로그인하면 이미 푼 문제를 추천에서 빼고, 푼 문제를 자동으로 확인해요',
          });
        }
        // 이전에 성공한 기록이 있으면 유지(백그라운드 요청에 로그인 쿠키가 실리지 않은 경우)
      } else {
        const stale = staleDailyIds(s, solved, t);
        const r = applySync(s, solved, t, { skipIds: stale });
        const replaced = stale.length ? rerollToday(s, t, { force: true }).ok : false;
        Object.assign(ss, { ok: true, signedIn: true, via, message: `해결한 문제 ${r.total}개 확인` });
        res = { ...r, replaced };
      }
      ensureDay(s, today, t);
      return res;
    });
    await refreshBadge();
    return out;
  }

  async function syncSolved({ force = false } = {}) {
    const t = now();
    const go = await store.update((s) => {
      const due = force || isSyncDue(s, t);
      if (due) s.solvedSync.attemptAt = t;
      return due;
    });
    if (!go) return { skipped: true };
    try {
      const { solved } = await fetchSolvedList({ fetchImpl, credentials: 'include' });
      const signedIn = solved.length ? true : await checkSignedIn({ fetchImpl }).catch(() => null);
      return await applySyncResult({ solved, signedIn, via: 'background' });
    } catch (e) {
      const message = `동기화 실패: ${e?.message ?? e}`;
      await store.update((s) => {
        Object.assign(s.solvedSync, { ok: false, message });
      });
      return { ok: false, error: message };
    }
  }

  // ── 메시지 ─────────────────────────────────────────────
  function roleOf(s, today, id) {
    const day = s.days[today];
    const r = s.records[id];
    if (day?.problemId === id) return { role: 'daily', topic: day.topic, level: r?.level };
    if (day?.reviewIds?.includes(id)) return { role: 'review', topic: r?.topics?.[0], level: r?.level, tries: r?.recommendedOn?.length ?? 1 };
    if (r?.status === 'missed') return { role: 'queued', topic: r.topics?.[0], level: r.level, nextReviewOn: r.nextReviewOn };
    return { role: null, topic: r?.topics?.[0] ?? null, level: r?.level ?? null };
  }

  async function handleMessage(msg = {}) {
    const t = now();
    switch (msg.type) {
      case 'getState': {
        const state = await store.update((s) => {
          prepare(s, t);
          return s;
        });
        return { state };
      }
      case 'opened': {
        return store.update((s) => {
          const today = prepare(s, t);
          recordOpen(s, { id: msg.id, at: t });
          return roleOf(s, today, Number(msg.id));
        });
      }
      case 'submission': {
        const res = await store.update((s) => {
          const today = prepare(s, t);
          const { record, firstSolve } = recordSubmission(s, {
            id: msg.id,
            passed: Boolean(msg.passed),
            title: msg.title,
            level: msg.level,
            lang: msg.lang,
            at: t,
          });
          return {
            ...roleOf(s, today, record.id),
            firstSolve,
            passed: Boolean(msg.passed),
            wrong: record.wrong,
            status: record.status,
            streak: summarize(s, today).streak,
          };
        });
        await refreshBadge();
        return res;
      }
      case 'syncStatus':
        return store.update((s) => {
          const due = isSyncDue(s, t);
          if (due) s.solvedSync.attemptAt = t;
          return { due };
        });
      case 'syncResult':
        return applySyncResult({ solved: Array.isArray(msg.solved) ? msg.solved : [], signedIn: msg.signedIn ?? null, via: 'page' });
      case 'syncNow':
        return syncSolved({ force: true });
      case 'manual': {
        const res = await store.update((s) => {
          prepare(s, t);
          return manualAction(s, { id: msg.id, action: msg.action, at: t });
        });
        await refreshBadge();
        return res;
      }
      case 'reroll': {
        const res = await store.update((s) => {
          prepare(s, t);
          return rerollToday(s, t);
        });
        await refreshBadge();
        return res;
      }
      case 'updateSettings': {
        const settings = await store.update((s) => updateSettings(s, msg.patch ?? {}));
        await scheduleAlarms();
        await refreshBadge();
        return { settings };
      }
      case 'export':
        return { state: await store.read() };
      case 'import': {
        if (!looksLikeState(msg.state)) throw new Error('1일1코 백업 파일이 아니에요');
        await store.replace(msg.state);
        await scheduleAlarms();
        await tick('import');
        return {};
      }
      case 'reset': {
        const cur = await store.read();
        const next = createInitialState(t);
        if (msg.keepSettings) next.settings = cur.settings;
        await store.replace(next);
        await tick('reset');
        return {};
      }
      case 'testNotification':
        await testNotification();
        return {};
      case 'openProblem':
        await openProblem(msg.id);
        return {};
      default:
        throw new Error(`알 수 없는 요청: ${msg.type}`);
    }
  }

  // ── 설치·시작 ──────────────────────────────────────────
  async function onInstalled(details = {}) {
    await scheduleAlarms();
    if (details.reason === 'install') {
      // 이미 푼 문제를 먼저 가져와야 오늘의 문제로 추천하지 않는다(로그인 안 돼 있으면 조용히 넘어감)
      await syncSolved({ force: true }).catch(() => {});
      await tick('install');
      await chrome.tabs.create({ url: dashboardUrl('#welcome') });
    } else {
      await tick(details.reason ?? 'update');
    }
  }

  async function onStartup() {
    await scheduleAlarms();
    await tick('startup');
  }

  return {
    scheduleAlarms,
    onAlarm,
    tick,
    onNotificationClicked,
    onNotificationButton,
    refreshBadge,
    syncSolved,
    applySyncResult,
    handleMessage,
    onInstalled,
    onStartup,
    testNotification,
  };
}
