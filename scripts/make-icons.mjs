#!/usr/bin/env node
// 아이콘 PNG 만들기: icons/src/*.svg → icons/icon{16,32,48,128}.png + store/images/icon-store-128.png
// 16·32px(툴바)는 장식 없는 icon-small.svg, 48·128px 는 달력 장식이 있는 icon.svg 를 쓴다.
// 스토어 아이콘은 권장 규격대로 128 캔버스에 그림 96 + 사방 16px 투명 여백.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep, tools } from './lib/chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(root, '.e2e-profile-icons');
const big = await readFile(path.join(root, 'icons', 'src', 'icon.svg'), 'utf8');
const small = await readFile(path.join(root, 'icons', 'src', 'icon-small.svg'), 'utf8');

const JOBS = [
  { svg: small, canvas: 16, art: 16, out: 'icons/icon16.png' },
  { svg: small, canvas: 32, art: 32, out: 'icons/icon32.png' },
  { svg: big, canvas: 48, art: 48, out: 'icons/icon48.png' },
  // 128px 는 웹스토어 가이드대로 그림 96 + 사방 16px 투명 여백 (설치 창·확장 관리 페이지에 쓰임)
  { svg: big, canvas: 128, art: 96, out: 'icons/icon128.png' },
  { svg: big, canvas: 128, art: 96, out: 'store/images/icon-store-128.png' },
];

const { proc, cdp } = await launchChrome({ profile: PROFILE });
const { evaluate, openPage } = tools(cdp);
try {
  for (const job of JOBS) {
    const page = await openPage('about:blank', { width: job.canvas, height: job.canvas });
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, page.sessionId);
    const pad = (job.canvas - job.art) / 2;
    const svg = job.svg.replace('<svg ', `<svg width="${job.art}" height="${job.art}" style="position:absolute;left:${pad}px;top:${pad}px" `);
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, page.sessionId);
    await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: `<html><body style="margin:0;background:transparent">${svg}</body></html>` }, page.sessionId);
    await evaluate(page.sessionId, 'document.fonts.ready.then(() => true)');
    await sleep(150);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, page.sessionId);
    await cdp.send('Target.closeTarget', { targetId: page.targetId });
    const file = path.join(root, job.out);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`저장: ${job.out}`);
  }
} finally {
  try {
    await cdp.send('Browser.close');
  } catch {
    /* 이미 닫힘 */
  }
  await sleep(300);
  proc.kill();
  await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
}
