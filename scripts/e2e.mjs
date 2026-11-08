#!/usr/bin/env node
// 실제 Chrome 에 확장을 올려 동작을 점검하고 스크린샷을 남긴다(별도 임시 프로필, 평소 프로필은 건드리지 않음).
//
// 사용: node scripts/e2e.mjs [--headed] [--offline] [--shots <폴더>]
//   --offline  프로그래머스 실제 페이지를 쓰는 검사(풀이 감지·동기화)를 건너뛴다
//   CHROME_PATH 환경변수로 브라우저 경로를 바꿀 수 있다
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoState } from '../dev/scenario.mjs';
import { dateKey } from '../src/lib/dates.js';
import { launchChrome, sleep, tools } from './lib/chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const OFFLINE = args.includes('--offline');
const shotsArg = args.indexOf('--shots');
const SHOTS = shotsArg >= 0 ? path.resolve(args[shotsArg + 1]) : path.join(root, 'docs', 'screenshots');
const PROFILE = path.join(root, '.e2e-profile');
const PRIVATE_SHOTS = path.join(os.tmpdir(), 'coding-daily-e2e');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const { proc, cdp } = await launchChrome({ profile: PROFILE, headed: HEADED });
  const { evaluate, waitUntil, openPage, loadExtension } = tools(cdp);
  const shot = async (sessionId, name, { fullPage = false } = {}) => {
    const params = { format: 'png' };
    if (fullPage) {
      const m = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
      const size = m.cssContentSize ?? m.contentSize;
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 6000), scale: 1 };
    }
    const { data } = await cdp.send('Page.captureScreenshot', params, sessionId);
    const file = path.join(SHOTS, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    return file;
  };

  try {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const version = await cdp.send('Browser.getVersion');
    console.log(`브라우저: ${version.product}`);

    // 1) 확장 설치 + 서비스 워커
    const { id: extId, sw, swSession: swS } = await loadExtension(root);
    check('확장 로드(manifest 유효)', extId, extId);
    check('서비스 워커(모듈) 실행', sw, sw?.url);
    const extUrl = (p) => `chrome-extension://${extId}/${p}`;
    const getState = () => evaluate(swS, `chrome.storage.local.get('state').then((x) => x.state)`);

    // 2) 설치 직후 상태
    const today = dateKey();
    await waitUntil(swS, `chrome.storage.local.get('state').then((x) => Boolean(x.state?.days?.['${today}']))`, 20_000);
    let st = await getState();
    const day = st.days[today];
    const daily = st.records[day.problemId];
    check('설치 직후 오늘의 문제 생성', day?.problemId, `${daily?.title} (${day?.topic}, Lv.${daily?.level})`);
    check('기본 설정 저장', st.settings.notifyTime === '09:00' && st.settings.retryIntervalDays === 3);
    const alarms = await evaluate(swS, `chrome.alarms.getAll().then((a) => a.map((x) => x.name).sort())`);
    check('알람 등록(daily·remind·midnight·tick)', ['daily', 'midnight', 'remind', 'tick'].every((n) => alarms.includes(n)), alarms.join(', '));
    await sleep(800);
    const { targetInfos: afterInstall } = await cdp.send('Target.getTargets');
    check('설치 시 환영 페이지 열림', afterInstall.some((t) => t.url.includes('dashboard.html#welcome')));
    check('비로그인 동기화 처리', st.solvedSync.ok === false || st.solvedSync.ok === true, st.solvedSync.message);

    // 3) 알림·배지
    await evaluate(swS, `self.codingDaily.handleMessage({ type: 'updateSettings', patch: { notifyTime: '00:00' } })`);
    await evaluate(swS, `self.codingDaily.tick('e2e')`);
    const notes = await evaluate(swS, `chrome.notifications.getAll().then((n) => Object.keys(n))`);
    check('아침 알림 생성', notes.some((n) => n.startsWith(`daily|${today}|`)), notes.join(', ') || '(없음)');
    const badge = await evaluate(swS, `chrome.action.getBadgeText({})`);
    check('배지에 남은 문제 수 표시', badge === '1', `badge='${badge}'`);
    await evaluate(swS, `self.codingDaily.handleMessage({ type: 'updateSettings', patch: { notifyTime: '09:00' } })`);
    await evaluate(swS, `self.codingDaily.handleMessage({ type: 'testNotification' })`);
    const notes2 = await evaluate(swS, `chrome.notifications.getAll().then((n) => Object.keys(n))`);
    check('테스트 알림', notes2.some((n) => n.startsWith('test|')));

    // 4) 프로그래머스 실제 문제 페이지에서 풀이 감지
    if (!OFFLINE) {
      const pid = day.problemId;
      const page = await openPage(`https://school.programmers.co.kr/learn/courses/30/lessons/${pid}`);
      const opened = await waitUntil(swS, `chrome.storage.local.get('state').then((x) => x.state.records[${pid}]?.firstOpenedAt ?? null)`, 15_000).catch(() => null);
      check('문제 페이지 열람 기록(content script)', opened);
      const hasModal = await evaluate(page.sessionId, `Boolean(document.querySelector('#modal-dialog')) && Boolean(document.querySelector('.lesson-content[data-lesson-id]'))`);
      check('페이지 구조 확인(#modal-dialog, .lesson-content)', hasModal);
      const toastShown = await waitUntil(page.sessionId, `document.getElementById('coding-daily-toast')?.shadowRoot?.textContent.includes('오늘의 추천 문제') ?? false`, 8000).catch(() => false);
      check('오늘의 추천 문제 안내 토스트', toastShown);

      // 채점 결과 모달을 실제 사이트와 같은 위치(#modal-dialog)에 그려 넣어 감지 경로를 검사
      const putModal = (title, body) =>
        evaluate(
          page.sessionId,
          `(() => { const m = document.querySelector('#modal-dialog'); m.innerHTML = '<div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h4 class="modal-title">${title}</h4></div><div class="modal-body">${body}</div></div></div>'; return true; })()`,
        );
      await putModal('틀렸습니다.', '채점 결과 정확성: 41.7 합계: 41.7 / 100.0');
      const wrong = await waitUntil(swS, `chrome.storage.local.get('state').then((x) => x.state.records[${pid}].wrong)`, 8000).catch(() => 0);
      check('오답 감지 → 오답 수 +1', wrong === 1, `wrong=${wrong}`);
      await evaluate(page.sessionId, `document.querySelector('#modal-dialog').innerHTML = ''; true`);
      await sleep(600);
      await putModal('정답입니다!', '채점 결과 정확성: 100.0 합계: 100.0 / 100.0');
      const solved = await waitUntil(swS, `chrome.storage.local.get('state').then((x) => x.state.records[${pid}].status === 'solved' ? x.state.records[${pid}] : null)`, 8000).catch(() => null);
      check('정답 감지 → 해결 처리', solved?.solvedVia === 'detect', solved ? `오답 ${solved.wrong}회 후 정답` : '');
      const passToast = await waitUntil(page.sessionId, `document.getElementById('coding-daily-toast')?.shadowRoot?.textContent.includes('오늘의 문제 해결') ?? false`, 5000).catch(() => false);
      check('해결 축하 토스트', passToast);
      const badge2 = await evaluate(swS, `chrome.action.getBadgeText({})`);
      check('해결 후 배지 ✓', badge2 === '✓', `badge='${badge2}'`);
      // 프로그래머스 화면이 담기므로 저장소(docs) 대신 임시 폴더에 저장
      const { data: toastPng } = await cdp.send('Page.captureScreenshot', { format: 'png' }, page.sessionId);
      await mkdir(PRIVATE_SHOTS, { recursive: true });
      await writeFile(path.join(PRIVATE_SHOTS, 'detect-toast.png'), Buffer.from(toastPng, 'base64'));
      await cdp.send('Target.closeTarget', { targetId: page.targetId });

      // 콘솔 점수만 바뀌는 경우(모달 문구가 바뀌어도): 제출 버튼 클릭 → #output 에 합계
      const other = 42586; // 기능개발
      const p2 = await openPage(`https://school.programmers.co.kr/learn/courses/30/lessons/${other}`);
      await waitUntil(swS, `chrome.storage.local.get('state').then((x) => x.state.opens?.[${other}] ?? x.state.records[${other}]?.firstOpenedAt ?? null)`, 15_000).catch(() => null);
      await evaluate(
        p2.sessionId,
        `(() => { const b = document.createElement('button'); b.id = 'submit-code'; b.textContent = '제출 후 채점하기'; document.body.appendChild(b); b.click();
          let out = document.querySelector('#output'); if (!out) { out = document.createElement('div'); out.id = 'output'; document.body.appendChild(out); }
          setTimeout(() => { out.textContent = '채점을 시작합니다. 정확성 테스트 ... 채점 결과 정확성: 100.0 합계: 100.0 / 100.0'; }, 400); return true; })()`,
      );
      const selfSolved = await waitUntil(swS, `chrome.storage.local.get('state').then((x) => x.state.records[${other}]?.status === 'solved')`, 8000).catch(() => false);
      check('콘솔 합계 점수로도 감지(추천 밖 문제 = 스스로 푼 문제)', selfSolved);
      await cdp.send('Target.closeTarget', { targetId: p2.targetId });

      // 실제 API 로 동기화(비로그인이라 0문제가 정상) — 네트워크·응답 형식 확인
      const sync = await evaluate(swS, `self.codingDaily.syncSolved({ force: true })`);
      st = await getState();
      check('프로그래머스 API 동기화 호출', sync && !sync.error, `${st.solvedSync.message} (signedIn=${st.solvedSync.signedIn})`);
    }

    // 5) 데모 데이터로 화면 스크린샷
    const demo = buildDemoState({ today });
    await evaluate(swS, `chrome.storage.local.set({ state: ${JSON.stringify(demo)} }).then(() => self.codingDaily.refreshBadge()).then(() => true)`);

    const popup = await openPage(extUrl('src/popup/popup.html'), { width: 368, height: 640, scale: 2 });
    const popupTitle = await waitUntil(popup.sessionId, `document.querySelector('.today .title')?.textContent`);
    check('팝업: 오늘의 문제 표시', popupTitle, popupTitle);
    const weakRows = await evaluate(popup.sessionId, `document.querySelectorAll('.weak-row').length`);
    check('팝업: 약한 유형 표시', weakRows > 0, `${weakRows}개`);
    const popupH = await evaluate(popup.sessionId, `Math.ceil(document.getElementById('app').getBoundingClientRect().height)`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 368, height: Math.min(popupH, 900), deviceScaleFactor: 2, mobile: false }, popup.sessionId);
    await shot(popup.sessionId, 'popup');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, popup.sessionId);
    await sleep(200);
    await shot(popup.sessionId, 'popup-dark');

    const dash = await openPage(extUrl('src/dashboard/dashboard.html#overview'), { width: 1280, height: 900 });
    await waitUntil(dash.sessionId, `document.querySelector('.today-hero .title')?.textContent`);
    const cells = await evaluate(dash.sessionId, `document.querySelectorAll('.heat-cell[data-l]:not([data-l="0"])').length`);
    check('대시보드: 잔디에 해결 기록 표시', cells > 0, `${cells}칸`);
    await shot(dash.sessionId, 'dashboard-overview', { fullPage: true });

    await evaluate(dash.sessionId, `location.hash = '#weakness'; true`);
    await waitUntil(dash.sessionId, `document.querySelectorAll('.bar-row').length === 14`);
    const weakTop = await evaluate(dash.sessionId, `[...document.querySelectorAll('.weak-card .name')].map((e) => e.textContent).join(', ')`);
    check('약점 분석: 약한 유형 TOP3', weakTop, weakTop);
    await shot(dash.sessionId, 'dashboard-weakness', { fullPage: true });

    await evaluate(dash.sessionId, `location.hash = '#history'; true`);
    const rows = await waitUntil(dash.sessionId, `document.querySelectorAll('tbody tr').length`);
    check('기록: 풀이 기록 표', rows > 5, `${rows}행`);
    await shot(dash.sessionId, 'dashboard-history');

    await evaluate(dash.sessionId, `location.hash = '#settings'; true`);
    await waitUntil(dash.sessionId, `document.querySelectorAll('.topic-checks input').length === 14`);
    await shot(dash.sessionId, 'dashboard-settings', { fullPage: true });

    // 설정 변경이 서비스 워커까지 반영되는지
    await evaluate(
      dash.sessionId,
      `(() => { const i = document.querySelector('input[aria-label="복습 간격"]'); i.value = '5'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
    );
    await sleep(800);
    st = await getState();
    check('설정 화면 → 저장 반영', st.settings.retryIntervalDays === 5, `retryIntervalDays=${st.settings.retryIntervalDays}`);

    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, dash.sessionId);
    await evaluate(dash.sessionId, `location.hash = '#overview'; true`);
    await sleep(400);
    await shot(dash.sessionId, 'dashboard-overview-dark');
  } catch (e) {
    check('E2E 실행', false, e.message);
  } finally {
    try {
      await cdp.send('Browser.close');
    } catch {
      /* 이미 닫힘 */
    }
    await sleep(500);
    proc.kill();
    await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 통과 · 스크린샷: ${SHOTS}`);
  process.exitCode = failed.length ? 1 : 0;
}

main();
