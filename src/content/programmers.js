// 프로그래머스 페이지에서 도는 content script.
// 1) 문제 페이지를 열면 '열람'을 기록하고, 오늘의 추천/복습 문제면 안내를 띄운다.
// 2) '제출 후 채점하기' 결과(정답입니다 / 틀렸습니다 / 합계 점수)를 감지해 기록한다.
// 3) 로그인 세션으로 '해결한 문제' 목록을 가져와 동기화한다(6시간마다, 프로그래머스 아무 페이지에서나).
(() => {
  'use strict';
  if (window.__codingDailyLoaded) return;
  window.__codingDailyLoaded = true;

  const LESSON_RE = /\/learn\/courses\/30\/lessons\/(\d+)/;
  const PASS_RE = /정답입니다/;
  const FAIL_RE = /틀렸습니다/;
  const SCORE_RE = /합계\s*[:：]\s*([\d.]+)\s*\/\s*([\d.]+)/;
  const ARM_WINDOW_MS = 3 * 60_000;
  const DEDUPE_MS = 10_000;
  const TOPIC_NAMES = {
    impl: '구현', bfs: 'DFS/BFS', brute: '완전탐색', dp: 'DP', greedy: '그리디', string: '문자열', hash: '해시',
    stack: '스택/큐', sort: '정렬', heap: '힙', bsearch: '이분탐색', graph: '그래프', twoptr: '투포인터', math: '수학',
  };

  // ── 메시지 ──────────────────────────────────────────────
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError; // 확장이 다시 로드된 경우 등
          resolve(res?.ok ? res.data ?? {} : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  // ── 페이지 정보 ─────────────────────────────────────────
  function signedInFlag() {
    const v = document.querySelector('[data-user-signed-in]')?.getAttribute('data-user-signed-in');
    return v === 'true' ? true : v === 'false' ? false : null;
  }

  function lessonInfo() {
    const m = LESSON_RE.exec(location.pathname);
    if (!m) return null;
    const el = document.querySelector('.lesson-content[data-lesson-id]') || document.querySelector('[data-lesson-id]');
    const id = Number(el?.getAttribute('data-lesson-id') || m[1]);
    const title =
      el?.getAttribute('data-lesson-title') ||
      document.querySelector('.challenge-title')?.textContent.trim() ||
      document.title.replace(/^코딩테스트 연습\s*-\s*/, '').replace(/\s*\|\s*프로그래머스 스쿨\s*$/, '');
    const level = Number(el?.getAttribute('data-challenge-level'));
    const lang = new URLSearchParams(location.search).get('language');
    return { id, title, level: Number.isFinite(level) ? level : null, lang };
  }

  // ── 안내 토스트 (페이지 CSS와 섞이지 않게 Shadow DOM) ───
  function toastHost() {
    let host = document.getElementById('coding-daily-toast');
    if (host) return host.shadowRoot;
    host = document.createElement('div');
    host.id = 'coding-daily-toast';
    // 오른쪽 아래엔 '코드 실행/제출' 버튼이 있어서 위쪽에 띄우고, 클릭은 그대로 통과시킨다
    host.style.cssText = 'position:fixed;right:20px;top:64px;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .stack{display:flex;flex-direction:column;gap:8px;align-items:flex-end;font-family:Pretendard,'Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif}
      .t{max-width:340px;padding:12px 16px;border-radius:12px;background:#1b1f27;color:#f1f3f5;box-shadow:0 8px 24px rgba(0,0,0,.25);
         font-size:14px;line-height:1.45;opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s}
      .t.in{opacity:1;transform:none}
      .t b{font-weight:700}
      .t .sub{display:block;margin-top:2px;color:#adb5bd;font-size:12.5px}
      .t.pass{border-left:4px solid #40c057}.t.fail{border-left:4px solid #fa5252}.t.info{border-left:4px solid #4dabf7}
    </style><div class="stack"></div>`;
    return root;
  }

  function toast(main, sub, tone = 'info', ms = 6000) {
    try {
      const stack = toastHost().querySelector('.stack');
      const el = document.createElement('div');
      el.className = `t ${tone}`;
      const b = document.createElement('b');
      b.textContent = main;
      el.appendChild(b);
      if (sub) {
        const s = document.createElement('span');
        s.className = 'sub';
        s.textContent = sub;
        el.appendChild(s);
      }
      stack.appendChild(el);
      requestAnimationFrame(() => el.classList.add('in'));
      setTimeout(() => {
        el.classList.remove('in');
        setTimeout(() => el.remove(), 300);
      }, ms);
    } catch {
      /* 토스트는 부가 기능 */
    }
  }

  const topicLabel = (key) => TOPIC_NAMES[key] || '미분류';

  // ── 1) 열람 기록 ────────────────────────────────────────
  let currentLesson = null;

  async function onLessonPage() {
    const info = lessonInfo();
    if (!info || !info.id) return;
    if (currentLesson?.id === info.id) return;
    currentLesson = info;
    const res = await send({ type: 'opened', id: info.id, title: info.title, level: info.level });
    if (!res) return;
    const lv = res.level ? ` Lv.${res.level}` : '';
    if (res.role === 'daily') toast('📌 오늘의 추천 문제예요', `${topicLabel(res.topic)}${lv} · 제출해서 정답이면 자동으로 기록돼요`, 'info', 5000);
    else if (res.role === 'review') toast('🔁 다시 도전하는 문제예요', `${topicLabel(res.topic)}${lv} · ${res.tries}번째 추천`, 'info', 5000);
  }

  // ── 2) 채점 결과 감지 ───────────────────────────────────
  let armedAt = 0; // '제출 후 채점하기'를 누른 시각
  let modalVerdict = null; // 결과 모달에 마지막으로 보인 판정(같은 판정을 두 번 세지 않게)
  let consoleBaseline = '';
  let lastReport = { at: 0, passed: null };

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const consoleText = () => norm(document.querySelector('#output')?.textContent);
  // 결과 모달: 지금은 #modal-dialog 에 그려지지만, 구조가 바뀌어도 '열린 모달'이면 같이 본다
  const modalText = () =>
    norm([...document.querySelectorAll('#modal-dialog, .modal.show, .modal.in')].map((el) => el.textContent).join(' '));

  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target instanceof Element ? e.target.closest('button, a, input[type="submit"], input[type="button"]') : null;
      if (!btn) return;
      const text = norm(btn.textContent || btn.value);
      if (btn.id === 'submit-code' || /제출\s*후\s*채점/.test(text)) {
        armedAt = Date.now();
        modalVerdict = null;
        consoleBaseline = consoleText();
      }
    },
    true,
  );

  async function report(passed, via) {
    const now = Date.now();
    if (now - lastReport.at < DEDUPE_MS && lastReport.passed === passed) return;
    lastReport = { at: now, passed };
    armedAt = 0;
    const info = lessonInfo();
    if (!info?.id) return;
    const res = await send({ type: 'submission', id: info.id, passed, title: info.title, level: info.level, lang: info.lang, via });
    if (!res) return;
    if (passed) {
      if (!res.firstSolve) return toast('✅ 정답! (이미 해결한 문제라 기록은 그대로예요)', null, 'pass', 4000);
      const streak = res.streak ? `🔥 ${res.streak}일 연속 해결` : '';
      if (res.role === 'daily') toast('✅ 오늘의 문제 해결! 기록했어요', streak || '내일 새 문제로 만나요', 'pass', 7000);
      else if (res.role === 'review') toast('✅ 복습 문제 해결! 복습 목록에서 뺐어요', streak, 'pass', 7000);
      else toast('✅ 해결 기록을 저장했어요', `${topicLabel(res.topic)} · 약점 분석에 반영돼요`, 'pass', 5000);
    } else if (res.role === 'daily' || res.role === 'review') {
      toast(`오답 ${res.wrong}회째 — 괜찮아요, 다시!`, '틀린 횟수는 약점 분석에만 쓰여요', 'fail', 4500);
    }
  }

  function check() {
    // (a) 결과 모달: "정답입니다!" / "틀렸습니다"
    const m = modalText();
    const verdict = PASS_RE.test(m) ? 'pass' : FAIL_RE.test(m) ? 'fail' : null;
    if (!verdict) modalVerdict = null;
    else if (verdict !== modalVerdict) {
      modalVerdict = verdict;
      report(verdict === 'pass', 'modal');
      return;
    }
    // (b) 콘솔 채점 결과: "합계: 100.0 / 100.0" (모달 문구가 바뀌어도 잡히도록 보조로)
    if (armedAt && Date.now() - armedAt < ARM_WINDOW_MS) {
      const c = consoleText();
      if (c && c !== consoleBaseline) {
        const s = SCORE_RE.exec(c);
        if (s) report(Number(s[1]) >= Number(s[2]) - 1e-9, 'console');
      }
    }
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      check();
    }, 250);
  });

  function startObserving() {
    if (!LESSON_RE.test(location.pathname)) return;
    observer.disconnect();
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ── 3) 해결 목록 동기화 ─────────────────────────────────
  async function maybeSync() {
    const st = await send({ type: 'syncStatus' });
    if (!st?.due) return;
    try {
      const solved = [];
      let page = 1;
      let totalPages = 1;
      do {
        const url = `${location.origin}/api/v2/school/challenges/?perPage=100&page=${page}&order=recent&statuses%5B%5D=solved`;
        const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        totalPages = Number(body.totalPages) || 0;
        for (const c of body.result || []) {
          if (c.status && c.status !== 'solved') continue;
          solved.push({ id: c.id, title: c.title, level: c.level, part: c.partTitle });
        }
        page += 1;
      } while (page <= totalPages && page <= 30);
      await send({ type: 'syncResult', solved, signedIn: solved.length ? true : signedInFlag() });
    } catch (e) {
      console.debug('[1일1코] 동기화 건너뜀', e);
    }
  }

  // ── 시작 & SPA 이동 감지 ────────────────────────────────
  function onRoute() {
    if (LESSON_RE.test(location.pathname)) {
      onLessonPage();
      startObserving();
    } else {
      currentLesson = null;
      observer.disconnect();
    }
  }

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onRoute();
    }
  }, 1000);

  onRoute();
  maybeSync();
})();
