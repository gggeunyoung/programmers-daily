#!/usr/bin/env node
// 로그인한 실제 계정으로 '제출 결과 감지'를 확인하는 대화형 점검.
// 확장을 올린 크롬 창(임시 프로필)을 띄우면 → 사용자가 직접 로그인하고 제출한다 → 확장 기록과 실제 결과 화면 구조를 출력한다.
// 로그인 화면·입력값은 읽지 않는다(문제 페이지의 결과 모달·콘솔만 본다). 끝나면 임시 프로필(로그인 쿠키 포함)을 지운다.
//
// 사용: node scripts/live-check.mjs [--minutes 25] [--problem 1845] [--lang python3]
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep, tools } from './lib/chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const MINUTES = Number(opt('minutes', 25));
const PROBLEM = Number(opt('problem', 1845));
const LANG = opt('lang', 'python3');
const PROFILE = path.join(root, '.e2e-live-profile');
const REPORT = path.join(os.tmpdir(), 'coding-daily-live', 'report.json');
const LESSON_RE = /^https:\/\/school\.programmers\.co\.kr\/learn\/courses\/30\/lessons\/\d+/;

const t0 = Date.now();
const stamp = () => {
  const s = Math.round((Date.now() - t0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const log = (...a) => console.log(`[${stamp()}]`, ...a);

// 문제 페이지에서 결과 관련 요소만 읽는다(메인 월드)
const SNAPSHOT_JS = `(() => {
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const shape = (node, depth = 0) => {
    if (!node || depth > 4) return '';
    const cls = typeof node.className === 'string' && node.className.trim() ? '.' + node.className.trim().split(/\\s+/).join('.') : '';
    const kids = [...node.children].slice(0, 5).map((c) => shape(c, depth + 1)).filter(Boolean);
    return node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + cls + (kids.length ? ' > [' + kids.join(', ') + ']' : '');
  };
  const modal = document.querySelector('#modal-dialog');
  const shown = [...document.querySelectorAll('.modal.show, .modal.in')];
  const out = document.querySelector('#output');
  const submit = document.querySelector('#submit-code') || [...document.querySelectorAll('button, a')].find((b) => /제출/.test(b.textContent));
  const host = document.getElementById('coding-daily-toast');
  return {
    url: location.pathname,
    signedIn: document.querySelector('[data-user-signed-in]')?.getAttribute('data-user-signed-in') ?? null,
    modalText: norm(modal?.textContent).slice(0, 300),
    modalShape: modal && modal.children.length ? shape(modal) : '',
    shownModals: shown.map((m) => (m.id ? '#' + m.id : '') + '.' + String(m.className).trim().split(/\\s+/).join('.')).join(' '),
    shownText: norm(shown.map((m) => m.textContent).join(' ')).slice(0, 300),
    output: norm(out?.textContent).slice(-260),
    submit: submit ? submit.tagName.toLowerCase() + (submit.id ? '#' + submit.id : '') + ' "' + norm(submit.textContent) + '"' : '(없음)',
    toast: norm(host?.shadowRoot?.textContent).slice(0, 200),
  };
})()`;

async function main() {
  const report = { startedAt: new Date().toISOString(), events: [], modals: [], outputs: [], submitButton: null, signedIn: null };
  const { proc, cdp } = await launchChrome({ profile: PROFILE, headed: true, flags: ['--window-size=1400,950'] });
  const { evaluate, attach, loadExtension } = tools(cdp);
  let browserClosed = false;
  proc.on('exit', () => {
    browserClosed = true;
  });

  try {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const { id: extId, swSession } = await loadExtension(root);
    log(`확장 로드 완료 (${extId})`);
    await sleep(1500);
    await cdp.send('Target.createTarget', {
      url: `https://school.programmers.co.kr/learn/courses/30/lessons/${PROBLEM}?language=${LANG}`,
    });
    log(`문제 ${PROBLEM} 페이지를 열었어요. 창에서 로그인한 뒤 '제출 후 채점하기'를 눌러 주세요.`);

    const sessions = new Map();
    const seen = { sync: '', signedIn: null, events: new Set(), modal: new Map(), shown: new Map(), output: new Map(), submit: '', toast: new Map() };
    let sawPass = false;
    let sawFail = false;
    const deadline = Date.now() + MINUTES * 60_000;

    while (!browserClosed && !cdp.closed && Date.now() < deadline) {
      // 1) 확장이 기록한 것
      const s = await evaluate(swSession, `chrome.storage.local.get('state').then((x) => x.state)`).catch(() => null);
      if (s) {
        const ss = s.solvedSync ?? {};
        const line = `ok=${ss.ok} · ${ss.message || '-'} · 해결 ${ss.ids?.length ?? 0}문제 · 경로=${ss.via ?? '-'}`;
        if (line !== seen.sync) {
          seen.sync = line;
          log(`동기화 상태: ${line}`);
          report.sync = { ...ss, ids: undefined, meta: undefined, count: ss.ids?.length ?? 0 };
        }
        for (const ev of s.events ?? []) {
          if (ev.t < t0 || !['pass', 'fail', 'solve'].includes(ev.type)) continue;
          const key = `${ev.t}|${ev.id}|${ev.type}`;
          if (seen.events.has(key)) continue;
          seen.events.add(key);
          const r = s.records?.[ev.id];
          const text = `${ev.type}${ev.via ? `(${ev.via})` : ''} · ${r?.title ?? ev.id} · 상태=${r?.status} 제출=${r?.submits} 오답=${r?.wrong}`;
          log(`확장 기록: ${text}`);
          report.events.push(text);
          if (ev.type === 'pass') sawPass = true;
          if (ev.type === 'fail') sawFail = true;
        }
      }

      // 2) 실제 문제 페이지의 결과 화면 구조 (로그인 페이지 등 다른 페이지는 읽지 않음)
      const { targetInfos } = await cdp.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
      for (const ti of targetInfos.filter((x) => x.type === 'page' && LESSON_RE.test(x.url))) {
        let sid = sessions.get(ti.targetId);
        if (!sid) {
          sid = await attach(ti.targetId).catch(() => null);
          if (!sid) continue;
          sessions.set(ti.targetId, sid);
        }
        const snap = await evaluate(sid, SNAPSHOT_JS).catch(() => null);
        if (!snap) continue;
        if (snap.signedIn !== seen.signedIn) {
          seen.signedIn = snap.signedIn;
          report.signedIn = snap.signedIn;
          log(`로그인 상태(문제 페이지 data-user-signed-in): ${snap.signedIn}`);
        }
        if (snap.submit !== seen.submit) {
          seen.submit = snap.submit;
          report.submitButton = snap.submit;
          log(`제출 버튼: ${snap.submit}`);
        }
        if (snap.modalText && seen.modal.get(ti.targetId) !== snap.modalText) {
          seen.modal.set(ti.targetId, snap.modalText);
          log(`#modal-dialog 텍스트: ${snap.modalText}`);
          log(`#modal-dialog 구조: ${snap.modalShape}`);
          report.modals.push({ text: snap.modalText, shape: snap.modalShape });
        }
        if (snap.shownText && seen.shown.get(ti.targetId) !== snap.shownText) {
          seen.shown.set(ti.targetId, snap.shownText);
          log(`열린 모달(${snap.shownModals}): ${snap.shownText}`);
        }
        if (snap.output && /채점|합계|정확성|통과|실패/.test(snap.output) && seen.output.get(ti.targetId) !== snap.output) {
          seen.output.set(ti.targetId, snap.output);
          log(`#output: …${snap.output}`);
          report.outputs.push(snap.output);
        }
        if (snap.toast && seen.toast.get(ti.targetId) !== snap.toast) {
          seen.toast.set(ti.targetId, snap.toast);
          log(`확장 안내: ${snap.toast}`);
        }
      }

      if (sawPass && sawFail) {
        log('정답·오답 감지를 모두 확인했어요. 20초 뒤 창을 닫고 임시 프로필을 지웁니다.');
        await sleep(20_000);
        break;
      }
      await sleep(1200);
    }
    if (!sawPass || !sawFail) log(`종료: 정답 감지=${sawPass}, 오답 감지=${sawFail}${browserClosed ? ' (창이 닫힘)' : Date.now() >= deadline ? ' (시간 초과)' : ''}`);
    report.sawPass = sawPass;
    report.sawFail = sawFail;
  } catch (e) {
    log(`오류: ${e.message}`);
    report.error = e.message;
  } finally {
    try {
      await cdp.send('Browser.close');
    } catch {
      /* 이미 닫힘 */
    }
    await sleep(800);
    proc.kill();
    await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
    await mkdir(path.dirname(REPORT), { recursive: true });
    await writeFile(REPORT, JSON.stringify(report, null, 2));
    log(`임시 프로필 삭제 · 리포트: ${REPORT}`);
  }
}

main();
