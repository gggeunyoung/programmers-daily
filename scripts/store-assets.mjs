#!/usr/bin/env node
// 크롬 웹스토어 등록 이미지 만들기 → store/images/
//   screenshots/2-overview ~ screenshots/5-history (1280x800), promo-small-440x280.png
//   (1번 대표 이미지는 store-main-image.mjs)
// 실제 확장 화면(데모 기록)을 헤드리스 Chrome 으로 찍고, 소개 컷은 같은 디자인으로 합성한다.
// 프로그래머스 사이트 화면은 쓰지 않는다(확장 자체 화면만).
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoState } from '../dev/scenario.mjs';
import { dateKey } from '../src/lib/dates.js';
import { launchChrome, sleep, tools } from './lib/chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'store', 'images');
const PROFILE = path.join(root, '.e2e-profile');
const FONT = `Pretendard, 'Malgun Gothic', 'Apple SD Gothic Neo', system-ui, sans-serif`;

const { proc, cdp } = await launchChrome({ profile: PROFILE });
const { evaluate, waitUntil, openPage, loadExtension } = tools(cdp);

async function capture(sessionId, { width, height, scale = 1 }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
  await sleep(300);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  return data;
}

async function compose(html, { width, height }) {
  const page = await openPage('about:blank', { width, height });
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, page.sessionId);
  await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, page.sessionId);
  await evaluate(page.sessionId, `Promise.all([...document.images].map((i) => i.decode().catch(() => null))).then(() => document.fonts.ready).then(() => true)`);
  await sleep(200);
  const data = await capture(page.sessionId, { width, height });
  await cdp.send('Target.closeTarget', { targetId: page.targetId });
  return data;
}

const save = (name, b64) => writeFile(path.join(OUT, name), Buffer.from(b64, 'base64'));

try {
  await mkdir(path.join(OUT, 'screenshots'), { recursive: true });
  const { id: extId, swSession } = await loadExtension(root);
  const extUrl = (p) => `chrome-extension://${extId}/${p}`;
  const today = dateKey();
  await waitUntil(swSession, `chrome.storage.local.get('state').then((x) => Boolean(x.state?.days?.['${today}']))`, 20_000);
  const demo = buildDemoState({ today });
  await evaluate(swSession, `chrome.storage.local.set({ state: ${JSON.stringify(demo)} }).then(() => true)`);
  // 합성 이미지 속 로고는 여백 없는 SVG 원본을 쓴다
  const icon = (await readFile(path.join(root, 'icons', 'src', 'icon.svg'))).toString('base64');

  // 대시보드 화면들(1280x800 그대로)
  // 640x400 으로 줄여 보여 주므로 1.25배로 크게 찍는다(1024x640 화면 → 1280x800 이미지)
  const dash = await openPage(extUrl('src/dashboard/dashboard.html#overview'), { width: 1024, height: 640, scale: 1.25 });
  await cdp.send('Emulation.setScrollbarsHidden', { hidden: true }, dash.sessionId); // 스크린샷에 스크롤바가 찍히지 않게
  await waitUntil(dash.sessionId, `document.querySelector('.today-hero .title')?.textContent`);
  await save('screenshots/2-overview.png', await capture(dash.sessionId, { width: 1024, height: 640, scale: 1.25 }));
  await evaluate(dash.sessionId, `location.hash = '#weakness'; true`);
  await waitUntil(dash.sessionId, `document.querySelectorAll('.bar-row').length === 14`);
  await save('screenshots/4-weakness.png', await capture(dash.sessionId, { width: 1024, height: 640, scale: 1.25 }));
  await evaluate(dash.sessionId, `location.hash = '#history'; true`);
  await waitUntil(dash.sessionId, `document.querySelectorAll('tbody tr').length > 3`);
  await save('screenshots/5-history.png', await capture(dash.sessionId, { width: 1024, height: 640, scale: 1.25 }));

  const base = `*{box-sizing:border-box}html,body{margin:0;font-family:${FONT};-webkit-font-smoothing:antialiased}`;

  // 1번 대표 이미지는 scripts/store-main-image.mjs 가 만든다(screenshots/1-main.png)

  // 3) 알림·자동 감지 컷 (확장 자체 UI 표현)
  await save(
    'screenshots/3-detect.png',
    await compose(
      `<!doctype html><html><head><meta charset="utf-8"><style>${base}
      body{width:1280px;height:800px;overflow:hidden;background:#11161f;color:#f1f3f5;position:relative}
      .copy{position:absolute;left:100px;top:140px}
      h1{margin:0 0 14px;font-size:46px;letter-spacing:-1.2px;font-weight:800}
      p{margin:0;font-size:21px;color:#adb5bd;line-height:1.6}
      .label{position:absolute;font-size:15px;font-weight:700;color:#74a8ef;letter-spacing:.3px}
      .note{position:absolute;left:100px;top:455px;width:470px;background:#2b2f37;border-radius:10px;padding:18px 20px;box-shadow:0 20px 50px rgba(0,0,0,.45)}
      .note .app{display:flex;align-items:center;gap:8px;font-size:14px;color:#c9ced6}
      .note .app img{width:18px;height:18px}
      .note h3{margin:14px 0 4px;font-size:19px}
      .note .m{font-size:17px;color:#e9ecef}
      .note .c{font-size:14px;color:#9aa1ab;margin-top:4px}
      .note .btns{display:flex;gap:8px;margin-top:16px}
      .note .btns span{flex:1;text-align:center;padding:10px 0;border-radius:6px;background:#3b414b;font-size:15px}
      .stack{position:absolute;right:100px;top:390px;display:flex;flex-direction:column;gap:14px;align-items:flex-end}
      .t{width:430px;padding:16px 20px;border-radius:14px;background:#1b1f27;box-shadow:0 12px 30px rgba(0,0,0,.4);font-size:19px;font-weight:700}
      .t span{display:block;margin-top:4px;font-size:15px;font-weight:500;color:#adb5bd}
      .t.info{border-left:5px solid #4dabf7}.t.fail{border-left:5px solid #fa5252}.t.pass{border-left:5px solid #40c057}
      </style></head><body>
      <div class="copy"><h1>제출만 하면 자동으로 체크</h1><p>정한 시각마다 같은 문제로 알림을 받고, 제출하면 정답·오답이<br>기록돼요. 풀면 그날 알림은 끝, 못 풀면 며칠 뒤 다시 알려 드려요.</p></div>
      <div class="label" style="left:100px;top:420px">정한 시각마다 알림 (기본 10·14·17·20시)</div>
      <div class="note">
        <div class="app"><img src="data:image/svg+xml;base64,${icon}">Google Chrome · 1일1코</div>
        <h3>오늘의 코테 · 해시 Lv.2</h3>
        <div class="m">전화번호 목록</div>
        <div class="c">🔥 4일 연속 해결 중 · 복습 1문제 대기</div>
        <div class="btns"><span>문제 풀러 가기</span><span>오늘은 그만 알림</span></div>
      </div>
      <div class="label" style="right:100px;top:355px">문제 페이지에서 제출하면</div>
      <div class="stack">
        <div class="t info">📌 오늘의 추천 문제예요<span>해시 Lv.2 · 제출해서 정답이면 자동으로 기록돼요</span></div>
        <div class="t fail">오답 1회째 — 괜찮아요, 다시!<span>틀린 횟수는 약점 분석에만 쓰여요</span></div>
        <div class="t pass">✅ 오늘의 문제 해결! 기록했어요<span>🔥 4일 연속 해결</span></div>
      </div>
      </body></html>`,
      { width: 1280, height: 800 },
    ),
  );

  // 작은 홍보 타일 440x280
  await save(
    'promo-small-440x280.png',
    await compose(
      `<!doctype html><html><head><meta charset="utf-8"><style>${base}
      body{width:440px;height:280px;overflow:hidden;background:linear-gradient(135deg,#3987e5 0%,#1c5cab 100%);color:#fff;display:flex;flex-direction:column;justify-content:center;padding:0 36px}
      .row{display:flex;align-items:center;gap:16px}
      img{width:72px;height:72px;filter:drop-shadow(0 6px 14px rgba(0,0,0,.25))}
      h1{margin:0;font-size:40px;font-weight:800;letter-spacing:-1px}
      p{margin:18px 0 0;font-size:21px;font-weight:700;color:#fff}
      small{display:block;margin-top:6px;font-size:15px;font-weight:600;color:#dbe9fb}
      </style></head><body>
      <div class="row"><img src="data:image/svg+xml;base64,${icon}"><h1>1일1코</h1></div>
      <p>하루에 알고리즘 하나</p>
      </body></html>`,
      { width: 440, height: 280 },
    ),
  );

  console.log(`저장: ${path.relative(root, OUT)}`);
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
