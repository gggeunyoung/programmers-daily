// 실제 Chrome 을 CDP(--remote-debugging-pipe)로 띄우고 확장을 올리는 공용 도구. e2e·live-check 에서 쓴다.
// Chrome 137+ 는 --load-extension 을 막아서 Extensions.loadUnpacked(--enable-unsafe-extension-debugging 필요)로 올린다.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome 을 찾지 못했어요. CHROME_PATH 를 지정하세요.');
  return found;
}

export class Cdp {
  constructor(proc) {
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.out = proc.stdio[3];
    const input = proc.stdio[4];
    input.setEncoding('utf8');
    let buf = '';
    input.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\0')) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (raw) this.dispatch(JSON.parse(raw));
      }
    });
    input.on('close', () => {
      this.closed = true;
      for (const { reject, method } of this.pending.values()) reject(new Error(`브라우저가 닫혔어요: ${method}`));
      this.pending.clear();
    });
  }

  dispatch(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, method } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message} ${msg.error.data ?? ''}`));
      else resolve(msg.result);
      return;
    }
    for (const l of [...this.listeners]) l(msg);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('브라우저가 닫혔어요'));
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.out.write(`${JSON.stringify(payload)}\0`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`시간 초과: ${method}`));
        }
      }, 45_000);
    });
  }

  waitFor(pred, timeout = 20_000) {
    return new Promise((resolve, reject) => {
      const l = (m) => {
        if (pred(m)) {
          this.listeners.delete(l);
          clearTimeout(timer);
          resolve(m);
        }
      };
      const timer = setTimeout(() => {
        this.listeners.delete(l);
        reject(new Error('이벤트 대기 시간 초과'));
      }, timeout);
      this.listeners.add(l);
    });
  }
}

/** 임시 프로필로 Chrome 실행. headed=false 면 헤드리스 */
export async function launchChrome({ profile, headed = false, flags = [] }) {
  await rm(profile, { recursive: true, force: true });
  const args = [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--lang=ko-KR',
    ...(headed ? [] : ['--headless=new', '--window-size=1280,900']),
    ...flags,
    'about:blank',
  ];
  const proc = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});
  const cdp = new Cdp(proc);
  return { proc, cdp };
}

export function tools(cdp) {
  const evaluate = async (sessionId, expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  const waitUntil = async (sessionId, expression, timeout = 15_000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = await evaluate(sessionId, expression);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(250);
    }
    throw new Error(`조건 대기 시간 초과: ${expression} (마지막 값: ${last})`);
  };

  const attach = async (targetId) => (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;

  const openPage = async (url, { width = 1280, height = 900, scale = 1, dark = false } = {}) => {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const sessionId = await attach(targetId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }, sessionId);
    const loaded = cdp.waitFor((m) => m.method === 'Page.loadEventFired' && m.sessionId === sessionId, 40_000);
    await cdp.send('Page.navigate', { url }, sessionId);
    await loaded;
    return { targetId, sessionId };
  };

  /** 확장을 올리고 서비스 워커에 붙는다 */
  const loadExtension = async (path) => {
    const { id } = await cdp.send('Extensions.loadUnpacked', { path });
    let sw = null;
    for (let i = 0; i < 40 && !sw; i += 1) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id));
      if (!sw) await sleep(250);
    }
    if (!sw) throw new Error('서비스 워커를 찾지 못했어요');
    const swSession = await attach(sw.targetId);
    await cdp.send('Runtime.enable', {}, swSession);
    return { id, sw, swSession };
  };

  return { evaluate, waitUntil, attach, openPage, loadExtension };
}
