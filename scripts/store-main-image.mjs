#!/usr/bin/env node
// 웹스토어 대표 이미지(첫 번째 스크린샷) 1280x800 → store/images/screenshots/1-main.png
// 군더더기 없이: 왼쪽은 이름·한 줄 소개·기능 3개, 오른쪽은 '알림 → 오늘의 문제 → 정답 기록' 흐름 한 컷.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep, tools } from './lib/chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'store', 'images', 'screenshots', '1-main.png');
const PROFILE = path.join(root, '.e2e-profile-main');
const FONT = `Pretendard, 'Malgun Gothic', 'Apple SD Gothic Neo', system-ui, sans-serif`;

const icon = (await readFile(path.join(root, 'icons', 'icon128.png'))).toString('base64');
const svg = (body) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON_BELL = svg('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>');
const ICON_CHECK = svg('<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><polyline points="22 4 12 14 9 11"/>');
const ICON_CHART = svg('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;font-family:${FONT};-webkit-font-smoothing:antialiased}
body{width:1280px;height:800px;overflow:hidden;display:flex;align-items:center;justify-content:space-between;padding:0 104px;
  background:
    radial-gradient(circle at 76% 52%, rgba(42,120,214,.17) 0, rgba(42,120,214,.07) 26%, rgba(42,120,214,0) 50%),
    linear-gradient(160deg,#fbfcfe 0%,#f3f6fa 100%);color:#0b0b0b}
.copy{width:540px}
.logo{display:flex;align-items:center;gap:10px}
.logo img{width:40px;height:40px}
.logo b{font-size:24px;font-weight:800;color:#1c5cab;letter-spacing:-.3px}
h1{margin:26px 0 18px;font-size:68px;line-height:1.12;letter-spacing:-2px;font-weight:800}
h1 span{color:#2a78d6}
.lead{margin:0 0 36px;font-size:21px;line-height:1.6;color:#52514e}
ul{list-style:none;margin:0;padding:0;display:grid;gap:18px}
li{display:flex;align-items:center;gap:14px}
li i{flex:0 0 46px;height:46px;border-radius:50%;background:#e6effb;color:#2a78d6;display:grid;place-items:center}
li b{display:block;font-size:19px;font-weight:700}
li small{display:block;margin-top:2px;font-size:15px;color:#7a7974}

.visual{position:relative;width:500px;height:424px}
.notif{position:absolute;z-index:2;top:0;right:0;width:372px;padding:15px 18px;border-radius:16px;background:#1b1f27;color:#f1f3f5;
  box-shadow:0 18px 40px rgba(11,11,11,.22)}
.nhead{display:flex;align-items:center;gap:7px;font-size:13px;color:#a5acb7}
.nhead img{width:16px;height:16px}
.ntitle{margin-top:8px;font-size:17px;font-weight:700}
.nmsg{margin-top:2px;font-size:15px;color:#d5d9df}
.card{position:absolute;top:78px;left:0;width:452px;padding:28px 30px 24px;border-radius:24px;background:#fff;
  border:1px solid rgba(11,11,11,.06);box-shadow:0 30px 70px rgba(28,92,171,.18),0 6px 18px rgba(11,11,11,.06)}
.crow{display:flex;align-items:center;justify-content:space-between}
.eyebrow{font-size:14px;font-weight:700;color:#1c5cab}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:#52514e}
.pill:before{content:'';width:9px;height:9px;border-radius:50%;background:#2a78d6;box-shadow:0 0 0 3px #e6effb}
.chips{display:flex;gap:6px;margin-top:14px}
.chip{height:26px;padding:0 11px;border-radius:999px;background:#f0efec;color:#52514e;font-size:13px;font-weight:700;display:inline-flex;align-items:center}
.chip.a{background:#e6effb;color:#1c5cab}
.chip.o{background:transparent;border:1px solid rgba(11,11,11,.12)}
.ctitle{margin-top:14px;font-size:30px;font-weight:800;letter-spacing:-.6px}
.cmeta{margin-top:4px;font-size:14.5px;color:#7a7974}
.cbtn{margin-top:22px;height:50px;border-radius:12px;background:#2a78d6;color:#fff;font-size:17px;font-weight:700;display:grid;place-items:center}
.cfoot{margin-top:16px;display:flex;justify-content:space-between;font-size:14px;color:#52514e}
.done{position:absolute;z-index:2;bottom:0;right:0;width:330px;padding:15px 18px;border-radius:16px;background:#1b1f27;color:#f1f3f5;
  border-left:5px solid #40c057;box-shadow:0 18px 40px rgba(11,11,11,.22)}
.done b{display:block;font-size:17px}
.done span{display:block;margin-top:3px;font-size:14px;color:#adb5bd}
</style></head><body>
<div class="copy">
  <div class="logo"><img src="data:image/png;base64,${icon}"><b>1일1코</b></div>
  <h1>하루에<br><span>알고리즘 하나</span></h1>
  <p class="lead">코테 단골 유형에서 매일 한 문제를 골라<br>알림으로 보내 드려요.</p>
  <ul>
    <li><i>${ICON_BELL}</i><div><b>하루 네 번 알림</b><small>같은 문제로, 풀면 그날 알림은 끝</small></div></li>
    <li><i>${ICON_CHECK}</i><div><b>제출하면 자동 체크</b><small>정답·오답을 알아서 기록해요</small></div></li>
    <li><i>${ICON_CHART}</i><div><b>약한 유형 분석</b><small>약한 유형은 더 자주 추천해요</small></div></li>
  </ul>
</div>
<div class="visual">
  <div class="notif">
    <div class="nhead"><img src="data:image/png;base64,${icon}">1일1코 · 오전 10:00</div>
    <div class="ntitle">오늘의 코테 · DFS/BFS Lv.2</div>
    <div class="nmsg">게임 맵 최단거리</div>
  </div>
  <div class="card">
    <div class="crow"><span class="eyebrow">오늘의 문제</span><span class="pill">도전 중</span></div>
    <div class="chips"><span class="chip a">DFS·BFS</span><span class="chip">Lv.2</span><span class="chip o">고득점 Kit</span></div>
    <div class="ctitle">게임 맵 최단거리</div>
    <div class="cmeta">깊이/너비 우선 탐색(DFS/BFS) · 정답률 67%</div>
    <div class="cbtn">문제 풀러 가기 →</div>
    <div class="cfoot"><span>🔥 7일 연속 해결 중</span><span>복습 대기 1문제</span></div>
  </div>
  <div class="done"><b>✅ 정답! 오늘의 문제 해결</b><span>🔥 8일 연속 해결</span></div>
</div>
</body></html>`;

const { proc, cdp } = await launchChrome({ profile: PROFILE });
const { evaluate, openPage } = tools(cdp);
try {
  const page = await openPage('about:blank', { width: 1280, height: 800 });
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, page.sessionId);
  await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, page.sessionId);
  await evaluate(page.sessionId, `Promise.all([...document.images].map((i) => i.decode().catch(() => null))).then(() => document.fonts.ready).then(() => true)`);
  await sleep(300);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, page.sessionId);
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, Buffer.from(data, 'base64'));
  console.log(`저장: ${path.relative(root, OUT)}`);
} finally {
  try {
    await cdp.send('Browser.close');
  } catch {
    /* 이미 닫힘 */
  }
  await sleep(400);
  proc.kill();
  await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
}
