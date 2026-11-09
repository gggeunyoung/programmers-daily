import { explainTopic, rankWeakTopics } from '../lib/analytics.js';
import { CATALOG_META } from '../lib/catalog.js';
import { dateKey, parseKey, prettyDate, relativeDay } from '../lib/dates.js';
import { problemUrl } from '../lib/programmers.js';
import { chooseInTopic } from '../lib/recommender.js';
import {
  buildFeedback,
  canSendDirect,
  envLine,
  FEEDBACK_EMAIL,
  issueUrl,
  KINDS,
  mailtoUrl,
  MAX_MESSAGE,
  sendDirect,
  validateFeedback,
} from '../lib/feedback.js';
import { DEFAULT_NOTIFY_TIMES, LANGUAGES, MAX_NOTIFY_TIMES } from '../lib/state.js';
import { TOPIC_MAP, TOPICS, topicName, topicShort } from '../lib/topics.js';
import {
  attemptSummary,
  heatmapWeeks,
  historyRows,
  importedRows,
  levelLabel,
  reviewHint,
  STATUS_META,
  todayView,
} from '../lib/view.js';
import { call, loadState, onStateChange, openUrl } from '../ui/api.js';
import { flash, REASON_TEXT, statusBadge } from '../ui/common.js';
import { h, mount } from '../ui/dom.js';

const viewEl = document.getElementById('view');
const tipEl = document.getElementById('tooltip');
let state = null;
const ui = { history: { status: 'all', topic: 'all', q: '' } };

const route = () => location.hash.replace('#', '') || 'overview';

async function init() {
  try {
    state = await loadState();
  } catch (e) {
    mount(viewEl, h('div', { class: 'empty' }, `불러오지 못했어요: ${e.message}`));
    return;
  }
  window.addEventListener('hashchange', () => {
    render();
    window.scrollTo(0, 0);
  });
  onStateChange((s) => {
    state = s;
    // 설정·의견 화면은 입력 중인 내용을 잃지 않도록 다시 그리지 않는다
    if (route() === 'settings') updateSyncStatus();
    else if (route() !== 'feedback') render();
  });
  render();
}

async function refresh() {
  state = await loadState();
  render();
}

async function act(type, payload, okMessage) {
  try {
    const res = await call(type, payload);
    if (res.ok === false) {
      flash(REASON_TEXT[res.reason] ?? '처리하지 못했어요');
      return res;
    }
    await refresh();
    if (okMessage) flash(okMessage);
    return res;
  } catch (e) {
    flash(e.message);
    return null;
  }
}

function render() {
  const r = route();
  const tab = r === 'welcome' ? 'overview' : r;
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', a.dataset.tab === tab);
  hideTip();
  const v = todayView(state, dateKey());
  if (r === 'history') mount(viewEl, historyPage(v));
  else if (r === 'weakness') mount(viewEl, weaknessPage(v));
  else if (r === 'settings') mount(viewEl, settingsPage(v));
  else if (r === 'feedback') mount(viewEl, feedbackPage());
  else mount(viewEl, overviewPage(v, r === 'welcome'));
}

// ── 툴팁 ──────────────────────────────────────────────────
function showTip(x, y, nodes) {
  mount(tipEl, nodes);
  tipEl.hidden = false;
  placeTip(x, y);
}
function placeTip(x, y) {
  const pad = 14;
  const r = tipEl.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - pad;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - pad;
  tipEl.style.left = `${Math.max(8, left)}px`;
  tipEl.style.top = `${Math.max(8, top)}px`;
}
function hideTip() {
  tipEl.hidden = true;
}
/** 마우스·키보드 모두에서 같은 내용을 보여준다 */
function withTip(el, content) {
  el.addEventListener('pointerenter', (e) => showTip(e.clientX, e.clientY, content()));
  el.addEventListener('pointermove', (e) => placeTip(e.clientX, e.clientY));
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('focus', () => {
    const r = el.getBoundingClientRect();
    showTip(r.left + r.width / 2, r.bottom, content());
  });
  el.addEventListener('blur', hideTip);
  return el;
}

// ── 공용 조각 ─────────────────────────────────────────────
const problemLink = (p, cls = 'title') =>
  h('a', { class: cls, href: p.url, target: '_blank', rel: 'noopener' }, p.title);

function chipsFor(p, mainTopic) {
  const topics = mainTopic ? [mainTopic, ...p.topics.filter((t) => t !== mainTopic)] : p.topics;
  return h(
    'div',
    { class: 'chips' },
    topics.slice(0, 3).map((t, i) => h('span', { class: `chip ${i === 0 ? 'accent' : ''}` }, topicShort(t))),
  );
}

function syncLine(sync) {
  if (sync.ok === false) return sync.message;
  if (!sync.at) return '아직 동기화하지 않았어요';
  return `${sync.message || '동기화 완료'} · ${relTime(sync.at)}`;
}

function relTime(t) {
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.round(hr / 24)}일 전`;
}

// ── 개요 ──────────────────────────────────────────────────
function overviewPage(v, welcome) {
  const firstDays = Object.keys(state.days).length <= 1;
  return [
    welcome || firstDays ? welcomeCard(v) : null,
    h('div', { class: 'overview-grid' }, todayHero(v), tiles(v)),
    heatmap(v),
    queue(v),
  ];
}

function welcomeCard(v) {
  const s = v.settings;
  return h(
    'section',
    { class: 'card welcome' },
    h('h2', null, '설치 완료! 오늘부터 하루 한 문제'),
    h(
      'div',
      { class: 'sub' },
      '매일 ',
      h('b', null, s.notifyTimes.join(' · ')),
      '에 오늘의 문제 하나를 알려 드려요. 그날 문제를 풀면 남은 알림은 오지 않아요.',
    ),
    h(
      'ol',
      null,
      h(
        'li',
        null,
        '프로그래머스에 ',
        h('b', null, '로그인'),
        '해 두세요. 이미 푼 문제는 추천에서 빠지고, 내가 푼 기록을 자동으로 가져와요. ',
        h('span', { class: v.sync.ok === false ? 'muted' : '' }, `(${syncLine(v.sync)})`),
      ),
      h('li', null, '문제 페이지에서 ', h('b', null, '제출 후 채점하기'), '로 정답이 나오면 자동으로 ‘해결’ 처리돼요.'),
      h('li', null, '못 푼 문제는 ', h('b', null, `${s.retryIntervalDays}일 뒤`), ' 다시 알려드리고, 약한 유형은 더 자주 나와요.'),
    ),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn primary', onClick: () => act('testNotification', {}, '알림을 보냈어요. 화면 구석을 확인해 보세요') }, '알림 테스트'),
      h('a', { class: 'btn', href: '#settings' }, '알림 시각·난이도 설정'),
      h('button', { class: 'btn ghost', onClick: () => openUrl('https://school.programmers.co.kr/learn/challenges') }, '프로그래머스 열기'),
    ),
  );
}

function todayHero(v) {
  const d = v.daily;
  if (!d) {
    return h(
      'section',
      { class: 'card today-hero' },
      h('span', { class: 'eyebrow' }, `오늘의 문제 · ${prettyDate(v.today)}`),
      h('p', { class: 'sub' }, '추천할 문제가 없어요. 설정에서 난이도나 유형 범위를 넓혀 보세요.'),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#settings' }, '설정 열기')),
    );
  }
  const r = d.record;
  const solved = d.status === 'solved';
  const actions = [h('a', { class: `btn ${solved ? '' : 'primary'}`, href: d.url, target: '_blank', rel: 'noopener' }, solved ? '문제 다시 보기' : '문제 풀러 가기 →')];
  if (!solved) {
    actions.push(
      h(
        'button',
        { class: 'btn', disabled: v.rerollsLeft <= 0, onClick: () => act('reroll', {}, '같은 유형의 다른 문제로 바꿨어요') },
        `다른 문제로 바꾸기 (${v.rerollsLeft})`,
      ),
      h('button', { class: 'btn ghost', onClick: () => act('manual', { id: d.id, action: 'solved' }, '해결로 기록했어요') }, '풀었어요 (직접 체크)'),
    );
  } else if (r?.solvedVia === 'manual') {
    actions.push(h('button', { class: 'btn ghost', onClick: () => act('manual', { id: d.id, action: 'unsolve' }, '되돌렸어요') }, '되돌리기'));
  }
  const target = d.targetLevel ? `이 유형 목표 난이도 Lv.${d.targetLevel}` : '';
  return h(
    'section',
    { class: 'card today-hero' },
    h('div', { class: 'eyebrow-row' }, h('span', { class: 'eyebrow' }, `오늘의 문제 · ${prettyDate(v.today)}`), statusBadge(d.status, solved ? '해결!' : undefined)),
    h(
      'div',
      { class: 'chips' },
      h('span', { class: 'chip accent' }, topicName(d.topic)),
      h('span', { class: 'chip' }, levelLabel(d.level)),
      d.tier && h('span', { class: 'chip outline' }, d.tier),
    ),
    h('h1', { class: 'title' }, d.title),
    h('div', { class: 'meta' }, [d.part, d.rate != null ? `정답률 ${d.rate}%` : null, target].filter(Boolean).join(' · ')),
    d.relaxed && h('div', { class: 'note' }, '설정한 난이도 범위의 문제를 다 풀어서 범위 밖에서 골랐어요.'),
    h(
      'div',
      { class: 'result' },
      solved
        ? attemptSummary(r) || '해결했어요'
        : r?.wrong
          ? `오답 ${r.wrong}회 — 정답을 제출하면 자동으로 체크돼요`
          : '프로그래머스에서 제출해 정답이 나오면 자동으로 체크돼요',
    ),
    h('div', { class: 'actions' }, actions),
  );
}

function tile(label, value, unit, foot) {
  return h(
    'div',
    { class: 'card tile' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value, unit && h('small', null, unit)),
    foot && h('div', { class: 'foot' }, foot),
  );
}

function tiles(v) {
  const s = v.summary;
  const rate = s.solveRate == null ? '-' : `${Math.round(s.solveRate * 100)}`;
  return h(
    'div',
    { class: 'tiles' },
    tile('연속 해결', `${s.streak}`, '일', `최장 ${s.longest}일`),
    tile('이번 달 해결', `${s.solvedThisMonth}`, '문제', `${parseKey(v.today).getMonth() + 1}월 기준`),
    tile('추천 문제 해결률', rate, s.solveRate == null ? '' : '%', `${s.solvedRecommended} / ${s.recommended}문제`),
    tile('복습 대기', `${s.reviewWaiting}`, '문제', s.reviewDue ? `오늘 복습 ${s.reviewDue}문제` : `${state.settings.retryIntervalDays}일 간격으로 다시 알려요`),
  );
}

function heatmap(v) {
  // 카드 폭에 맞춰 주 수를 정한다(넓으면 최대 1년)
  const avail = Math.min(viewEl.clientWidth || 1080, 1080) - 48 - 40 - 24;
  const WEEKS = Math.max(12, Math.min(53, Math.floor(avail / 16)));
  const cols = heatmapWeeks(v.summary.byDay, v.today, WEEKS);
  const lvl = (n) => (n <= 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 3 : 4);
  const total = cols.flat().reduce((a, c) => a + (c.future ? 0 : c.count), 0);
  const activeDays = cols.flat().filter((c) => c.count > 0).length;
  const colEls = cols.map((col) => {
    // 그 달 1일이 들어 있는 열에만 월을 적어 라벨이 겹치지 않게
    const first = col.find((c) => parseKey(c.key).getDate() === 1);
    const label = first ? `${parseKey(first.key).getMonth() + 1}월` : '';
    return h(
      'div',
      { class: 'heat-col' },
      h('span', { class: 'heat-month' }, label),
      col.map((c) => {
        if (c.future) return h('span', { class: 'heat-cell future', 'aria-hidden': 'true' });
        const text = `${prettyDate(c.key)} · ${c.count ? `${c.count}문제 해결` : '기록 없음'}`;
        return withTip(
          h('button', {
            class: `heat-cell ${c.key === v.today ? 'today' : ''}`,
            dataset: { l: String(lvl(c.count)) },
            'aria-label': text,
            type: 'button',
          }),
          () => [h('div', { class: 'v' }, c.count ? `${c.count}문제` : '0문제'), h('div', { class: 'k' }, prettyDate(c.key))],
        );
      }),
    );
  });
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return h(
    'section',
    { class: 'card section' },
    h('h2', null, '풀이 잔디', h('span', { class: 'aside' }, `${WEEKS >= 52 ? '최근 1년' : `최근 ${WEEKS}주`} · ${activeDays}일 동안 ${total}문제 해결`)),
    h(
      'div',
      { class: 'heat-wrap' },
      h('div', { class: 'heat-days', 'aria-hidden': 'true' }, h('span'), days.map((d, i) => h('span', null, i % 2 ? d : ''))),
      h('div', { class: 'heat-cols' }, colEls),
    ),
    h(
      'div',
      { class: 'heat-legend' },
      '적게',
      [0, 1, 2, 3, 4].map((l) => h('span', { class: 'heat-cell', dataset: { l: String(l) }, 'aria-hidden': 'true' })),
      '많이',
    ),
  );
}

function queue(v) {
  // 오늘 복습으로 올라온 문제 + 날짜를 기다리는 문제
  const todays = v.reviews.map((p) => ({ ...(p.record ?? {}), ...p, todayReview: true }));
  const waiting = v.queue.map((r) => ({ ...r, url: problemUrl(r.id, v.settings.language) }));
  const rows = [...todays, ...waiting];
  return h(
    'section',
    { class: 'card section' },
    h('h2', null, '다시 도전', h('span', { class: 'aside' }, `못 푼 문제는 ${v.settings.retryIntervalDays}일 간격으로 다시 추천돼요`)),
    rows.length
      ? h(
          'ul',
          { class: 'qlist' },
          rows.map((r) => {
            const last = r.recommendedOn?.[r.recommendedOn.length - 1];
            const solved = r.status === 'solved';
            const when = r.todayReview ? (solved ? statusBadge('solved', '오늘 해결') : h('span', { class: 'when due' }, '오늘 복습')) : h('span', { class: 'when' }, reviewHint(r, v.today));
            return h(
              'li',
              { class: 'qrow' },
              h(
                'div',
                { class: 'main' },
                problemLink(r),
                h(
                  'div',
                  { class: 'sub' },
                  [topicShort(r.topics?.[0]), levelLabel(r.level), `${r.missCount ?? 0}번 놓침`, !r.todayReview && last ? `마지막 추천 ${relativeDay(last, v.today)}` : null]
                    .filter(Boolean)
                    .join(' · '),
                ),
              ),
              when,
              solved
                ? null
                : h(
                    'div',
                    { class: 'btns' },
                    !r.todayReview &&
                      !r.due &&
                      h('button', { class: 'btn small ghost', title: '다음 추천에 바로 넣어요', onClick: () => act('manual', { id: r.id, action: 'review-now' }, '다음 추천에 넣었어요') }, '앞당기기'),
                    h('button', { class: 'btn small ghost', onClick: () => act('manual', { id: r.id, action: 'solved' }, '해결로 기록했어요') }, '풀었어요'),
                    h('button', { class: 'btn small ghost danger', onClick: () => act('manual', { id: r.id, action: 'drop' }, '더 이상 추천하지 않아요') }, '그만 보기'),
                  ),
            );
          }),
        )
      : h('div', { class: 'empty' }, '다시 볼 문제가 없어요. 추천 문제를 그날 못 풀면 여기에 쌓여요.'),
  );
}

// ── 기록 ──────────────────────────────────────────────────
function historyPage(v) {
  const f = ui.history;
  const tableHost = h('div', { class: 'table-wrap' });
  const countEl = h('span', { class: 'count' });
  const draw = () => {
    const rows = historyRows(state, f);
    countEl.textContent = `${rows.length}문제`;
    mount(tableHost, rows.length ? historyTable(rows, v) : h('div', { class: 'empty' }, '조건에 맞는 기록이 없어요.'));
  };
  const statusOptions = [['all', '전체 상태'], ...Object.entries(STATUS_META).filter(([k]) => k !== 'imported').map(([k, m]) => [k, m.label])];
  const filters = h(
    'div',
    { class: 'filters' },
    h(
      'select',
      { 'aria-label': '상태', onChange: (e) => { f.status = e.target.value; draw(); } },
      statusOptions.map(([val, label]) => h('option', { value: val, selected: f.status === val }, label)),
    ),
    h(
      'select',
      { 'aria-label': '유형', onChange: (e) => { f.topic = e.target.value; draw(); } },
      h('option', { value: 'all', selected: f.topic === 'all' }, '전체 유형'),
      TOPICS.map((t) => h('option', { value: t.key, selected: f.topic === t.key }, t.name)),
    ),
    h('input', { type: 'search', placeholder: '문제 이름·번호 검색', value: f.q, onInput: (e) => { f.q = e.target.value; draw(); } }),
    countEl,
  );
  draw();
  const imported = importedRows(state);
  return [
    h('div', null, h('h1', { class: 'page-title' }, '풀이 기록'), h('p', { class: 'page-desc' }, '추천받은 문제와 스스로 풀어본 문제의 결과예요. 제목을 누르면 문제가 열려요.')),
    filters,
    h('section', { class: 'card section' }, tableHost),
    imported.length
      ? h(
          'section',
          { class: 'card section' },
          h(
            'details',
            { class: 'imported' },
            h('summary', null, `프로그래머스에서 가져온 해결 기록 ${imported.length}문제`, h('span', { class: 'muted', style: { fontWeight: 500, fontSize: '12.5px' } }, '(확장 설치 전에 푼 문제 포함 · 추천에서 제외돼요)')),
            h(
              'div',
              { class: 'imported-grid' },
              imported.map((p) => h('div', null, h('a', { href: p.url, target: '_blank', rel: 'noopener' }, p.title), h('span', { class: 'lv' }, levelLabel(p.level)))),
            ),
          ),
        )
      : null,
  ];
}

function historyTable(rows, v) {
  return h(
    'table',
    null,
    h('thead', null, h('tr', null, h('th', null, '날짜'), h('th', null, '문제'), h('th', null, '유형'), h('th', null, '난이도'), h('th', null, '상태'), h('th', null, '기록'), h('th', null, ''))),
    h(
      'tbody',
      null,
      rows.map((row) => {
        const r = row.record;
        const actions = [];
        if (row.status === 'solved' && r?.solvedVia === 'manual') actions.push(['unsolve', '되돌리기']);
        if (row.status !== 'solved' && row.status !== 'dropped') actions.push(['solved', '풀었어요'], ['drop', '그만 보기']);
        if (row.status === 'dropped') actions.push(['restore', '다시 추천']);
        return h(
          'tr',
          null,
          h('td', { class: 'num' }, row.firstDay ? row.firstDay.slice(5).replace('-', '.') : '-'),
          h('td', null, problemLink(row), h('span', { class: 'part' }, `${row.source} · ${row.part || '프로그래머스'}`)),
          h('td', null, chipsFor(row)),
          h('td', null, levelLabel(row.level)),
          h('td', null, statusBadge(row.status), row.status === 'missed' ? h('div', { class: 'part' }, reviewHint(r, v.today)) : null),
          h('td', { class: 'sub' }, row.summary || '-'),
          h(
            'td',
            null,
            h(
              'div',
              { class: 'btns', style: { display: 'flex', gap: '4px', justifyContent: 'flex-end' } },
              actions.map(([action, label]) =>
                h('button', { class: `btn small ghost ${action === 'drop' ? 'danger' : ''}`, onClick: () => act('manual', { id: row.id, action }, '반영했어요') }, label),
              ),
            ),
          ),
        );
      }),
    ),
  );
}

// ── 약점 분석 ─────────────────────────────────────────────
function weaknessPage(v) {
  const res = v.stats;
  const ranked = rankWeakTopics(res);
  const top = ranked.slice(0, 3);
  return [
    h(
      'div',
      null,
      h('h1', { class: 'page-title' }, '약점 분석'),
      h('p', { class: 'page-desc' }, '추천받거나 스스로 푼 문제의 결과로 유형별 약점 지수(0~100)를 계산해요. 약한 유형일수록 추천에 더 자주 나와요.'),
    ),
    top.length
      ? h('div', { class: 'weak-cards' }, top.map((st, i) => weakCard(st, i, v)))
      : h(
          'section',
          { class: 'card section' },
          h('div', { class: 'empty' }, '아직 데이터가 부족해요. 추천 문제를 3개 이상 풀거나 놓치면 약한 유형이 보이기 시작해요.'),
        ),
    barChart(res),
    statsTable(res, v),
    methodCard(res),
  ];
}

function weakCard(st, i, v) {
  const t = TOPIC_MAP[st.key];
  return h(
    'section',
    { class: 'card weak-card' },
    h('div', { class: 'rank' }, `약한 유형 ${i + 1}위`),
    h('div', { class: 'name' }, t.name),
    h('div', { class: 'score' }, '약점 지수 ', h('b', null, String(st.score))),
    h('div', { class: 'why' }, explainTopic(st)),
    h('div', { class: 'tip' }, t.tip),
    h(
      'button',
      {
        class: 'btn small',
        onClick: () => {
          const pick = chooseInTopic(state, v.today, st.key, { rng: Math.random });
          if (!pick) return flash('이 유형에 남은 문제가 없어요');
          openUrl(problemUrl(pick.problem.id, v.settings.language));
        },
      },
      '이 유형 한 문제 더 풀기',
    ),
  );
}

function barChart(res) {
  const list = Object.values(res.stats).sort((a, b) => {
    const ka = a.count ? (a.enough ? 0 : 1) : 2;
    const kb = b.count ? (b.enough ? 0 : 1) : 2;
    return ka - kb || b.score - a.score;
  });
  return h(
    'section',
    { class: 'card section' },
    h('h2', null, '유형별 약점 지수', h('span', { class: 'aside' }, '높을수록 약함 · 회색은 근거가 부족한 유형')),
    h(
      'div',
      { class: 'bars' },
      list.map((st) => {
        const lack = !st.enough;
        const row = h(
          'div',
          { class: `bar-row ${lack ? 'lack' : ''}`, tabindex: '0', 'aria-label': `${st.name} 약점 지수 ${st.count ? st.score : '기록 없음'}` },
          h('div', { class: 'name' }, st.name, lack && h('span', { class: 'lack' }, st.count ? '데이터 부족' : '기록 없음')),
          h(
            'div',
            { class: 'bar-track' },
            st.count ? h('div', { class: 'bar-fill', style: { width: `${st.score}%` } }) : null,
            st.count ? h('span', { class: 'bar-value', style: { left: `${st.score}%` } }, String(st.score)) : null,
          ),
        );
        return withTip(row, () => [
          h('div', { class: 'v' }, st.count ? `약점 지수 ${st.score}` : '기록 없음'),
          h('div', { class: 'k' }, st.name),
          h('div', { class: 'k' }, explainTopic(st)),
          h('div', { class: 'k' }, `카탈로그 진척 ${st.catalogSolved}/${st.catalogTotal}`),
        ]);
      }),
    ),
    h(
      'div',
      { class: 'bar-axis', 'aria-hidden': 'true' },
      h('span'),
      h('div', { class: 'ticks' }, ['0', '25', '50', '75', '100'].map((t) => h('span', null, t))),
    ),
  );
}

function statsTable(res, v) {
  const list = Object.values(res.stats).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const fmt = (x, d = 1) => (x == null ? '-' : x.toFixed(d));
  return h(
    'section',
    { class: 'card section' },
    h('h2', null, '유형별 상세', h('span', { class: 'aside' }, '진척도 = 이 확장이 아는 해당 유형 문제 중 내가 푼 비율')),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '유형'),
            h('th', { class: 'num' }, '푼 기록'),
            h('th', { class: 'num' }, '해결'),
            h('th', { class: 'num' }, '미해결'),
            h('th', { class: 'num' }, '늦게 해결'),
            h('th', { class: 'num' }, '평균 오답'),
            h('th', { class: 'num' }, '약점 지수'),
            h('th', { class: 'num' }, '진척도'),
            h('th', { class: 'num' }, '목표 난이도'),
          ),
        ),
        h(
          'tbody',
          null,
          list.map((st) => {
            const lv = state.topicLevel?.[st.key]?.level ?? v.settings.startLevel;
            return h(
              'tr',
              null,
              h('td', null, st.name),
              h('td', { class: 'num' }, String(st.count)),
              h('td', { class: 'num' }, String(st.solved)),
              h('td', { class: 'num' }, String(st.unsolved)),
              h('td', { class: 'num' }, String(st.lateSolved)),
              h('td', { class: 'num' }, st.count ? fmt(st.avgWrong) : '-'),
              h('td', { class: 'num' }, st.count ? String(st.score) : '-'),
              h('td', { class: 'num' }, `${st.catalogSolved}/${st.catalogTotal}`),
              h('td', { class: 'num' }, `Lv.${lv}`),
            );
          }),
        ),
      ),
    ),
  );
}

function methodCard(res) {
  return h(
    'section',
    { class: 'card section method' },
    h('h2', null, '이렇게 계산해요'),
    h(
      'div',
      null,
      '문제마다 ',
      h('b', null, '고전 점수'),
      '를 매겨요: 열어보거나 제출해 보고도 그날 못 풀면 1, 그렇게 놓쳤다가 나중에 풀면 0.5, 오답 제출 1회마다 +0.1(최대 0.4), 한 번에 풀면 0. ',
      '바빠서 열어보지도 못한 날은 실력과 무관하니 계산에서 빼요(복습 알림은 그대로 와요). ',
      '유형별로 평균을 내되, 몇 문제 안 푼 유형이 극단값이 되지 않도록 전체 평균(현재 ',
      h('code', null, `${Math.round(res.prior * 100)}`),
      ')을 가상 2문제만큼 섞어요(베이지안 평활). 주유형은 가중치 1, 보조 유형은 0.5로 반영해요.',
    ),
    h(
      'div',
      { style: { marginTop: '8px' } },
      '추천 비중: 약점 지수가 평균보다 높은 유형은 최대 2배까지 자주 나오고, 유형별 목표 난이도는 깔끔하게(놓치지 않고 오답 1회 이하) 2번 연속 풀면 한 단계 오르고, 놓치면 한 단계 내려가요.',
    ),
  );
}

// ── 설정 ──────────────────────────────────────────────────
let syncStatusEl = null;

function updateSyncStatus() {
  if (!syncStatusEl) return;
  syncStatusEl.textContent = syncLine(state.solvedSync);
  syncStatusEl.classList.toggle('warn', state.solvedSync.ok === false);
}

async function save(patch, message = '저장했어요') {
  try {
    const { settings } = await call('updateSettings', { patch });
    state.settings = settings;
    flash(message);
  } catch (e) {
    flash(e.message);
  }
}

function field(label, help, control) {
  return h('div', { class: 'field' }, h('div', { class: 'lbl' }, label, help && h('small', null, help)), h('div', { class: 'ctl' }, control));
}

/** 알림 시각 목록: 칩(× 로 빼기) + 시각 추가 + 기본값 */
function timesEditor() {
  const s = state.settings;
  const input = h('input', { type: 'time', value: '12:00', 'aria-label': '추가할 알림 시각' });
  const setTimes = (list, message) => save({ notifyTimes: list }, message).then(render);
  return h(
    'div',
    { class: 'times-editor' },
    h('div', { class: 'lbl' }, '알림 시각', h('small', null, `하루 최대 ${MAX_NOTIFY_TIMES}번 · 같은 날은 같은 문제로 알려요`)),
    h(
      'div',
      { class: 'times' },
      s.notifyTimes.map((t) =>
        h(
          'span',
          { class: 'time-chip' },
          t,
          h(
            'button',
            {
              class: 'x',
              type: 'button',
              title: '빼기',
              'aria-label': `${t} 알림 빼기`,
              onClick: () => {
                if (s.notifyTimes.length <= 1) return flash('알림 시각은 하나 이상 있어야 해요');
                return setTimes(s.notifyTimes.filter((x) => x !== t), `${t} 알림을 뺐어요`);
              },
            },
            '×',
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'times-add' },
      input,
      h(
        'button',
        {
          class: 'btn small',
          type: 'button',
          onClick: () => {
            const v = input.value;
            if (!v) return null;
            if (s.notifyTimes.includes(v)) return flash('이미 있는 시각이에요');
            if (s.notifyTimes.length >= MAX_NOTIFY_TIMES) return flash(`알림 시각은 ${MAX_NOTIFY_TIMES}개까지예요`);
            return setTimes([...s.notifyTimes, v], `${v} 알림을 추가했어요`);
          },
        },
        '시각 추가',
      ),
      h(
        'button',
        { class: 'btn small ghost', type: 'button', onClick: () => setTimes([...DEFAULT_NOTIFY_TIMES], '기본 시각으로 되돌렸어요') },
        '기본값(10·14·17·20시)',
      ),
    ),
  );
}

const SWITCH_LABEL = {
  enabled: '알림 켜기',
  adaptive: '약점 맞춤 추천 켜기',
  autoSync: '자동 동기화 켜기',
};

function switchInput(key) {
  return h('input', {
    type: 'checkbox',
    class: 'switch',
    role: 'switch',
    checked: Boolean(state.settings[key]),
    'aria-label': SWITCH_LABEL[key] ?? key,
    onChange: (e) => save({ [key]: e.target.checked }),
  });
}

function levelSelect(key, label) {
  return h(
    'select',
    { 'aria-label': label, onChange: (e) => save({ [key]: Number(e.target.value) }).then(render) },
    [1, 2, 3, 4, 5].map((n) => h('option', { value: String(n), selected: state.settings[key] === n }, `Lv.${n}`)),
  );
}

function settingsPage() {
  const s = state.settings;
  syncStatusEl = h('div', { class: 'sync-status' });
  updateSyncStatus();

  const notify = h(
    'section',
    { class: 'card section' },
    h('h2', null, '알림'),
    field('알림 받기', '정한 시각마다 오늘의 문제를 알려요. 풀면 그날 남은 알림은 오지 않아요', switchInput('enabled')),
    timesEditor(),
    field(
      '알림 확인',
      '알림이 안 보이면 윈도우 설정 > 알림에서 Chrome 을 허용하세요',
      h('button', { class: 'btn small', onClick: () => act('testNotification', {}, '테스트 알림을 보냈어요') }, '테스트 알림 보내기'),
    ),
  );

  const recommend = h(
    'section',
    { class: 'card section' },
    h('h2', null, '추천'),
    field('난이도 범위', '이 범위 안에서 추천해요', [levelSelect('minLevel', '최소 난이도'), '~', levelSelect('maxLevel', '최대 난이도')]),
    field('시작 난이도', '유형별 목표 난이도의 출발점', levelSelect('startLevel', '시작 난이도')),
    field(
      '못 푼 문제 다시 알림',
      '추천받은 날 못 풀면 며칠 뒤 다시 추천할지',
      h('span', null, h('input', { type: 'number', min: '1', max: '30', value: String(s.retryIntervalDays), 'aria-label': '복습 간격', onChange: (e) => save({ retryIntervalDays: Number(e.target.value) }) }), ' 일 뒤'),
    ),
    field(
      '하루 복습 최대',
      '새 문제와 별도로 함께 나오는 복습 문제 수',
      h('span', null, h('input', { type: 'number', min: '0', max: '5', value: String(s.maxReviewsPerDay), 'aria-label': '하루 복습 최대', onChange: (e) => save({ maxReviewsPerDay: Number(e.target.value) }) }), ' 문제'),
    ),
    field('약점 맞춤 추천', '약한 유형 비중↑, 유형별 난이도 자동 조절', switchInput('adaptive')),
    field(
      '풀이 언어',
      '문제를 열 때 이 언어로 에디터를 열어요',
      h(
        'select',
        { 'aria-label': '풀이 언어', onChange: (e) => save({ language: e.target.value }) },
        LANGUAGES.map(([val, label]) => h('option', { value: val, selected: s.language === val }, label)),
      ),
    ),
  );

  const topics = h(
    'section',
    { class: 'card section' },
    h('h2', null, '추천할 유형', h('span', { class: 'aside' }, '오른쪽 숫자는 기본 출제 비중')),
    h(
      'div',
      { class: 'topic-checks' },
      TOPICS.map((t) =>
        h(
          'label',
          { title: t.desc },
          h('input', {
            type: 'checkbox',
            checked: s.topics.includes(t.key),
            onChange: (e) => {
              const next = new Set(state.settings.topics);
              if (e.target.checked) next.add(t.key);
              else next.delete(t.key);
              if (!next.size) {
                e.target.checked = true;
                return flash('유형은 하나 이상 골라야 해요');
              }
              save({ topics: TOPICS.map((x) => x.key).filter((k) => next.has(k)) });
            },
          }),
          t.name,
          h('span', { class: 'w' }, '●'.repeat(t.weight)),
        ),
      ),
    ),
  );

  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    hidden: true,
    onChange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        await call('import', { state: json.state ?? json });
        await refresh();
        flash('백업을 불러왔어요');
      } catch (err) {
        flash(`불러오지 못했어요: ${err.message}`);
      }
      e.target.value = '';
    },
  });

  const data = h(
    'section',
    { class: 'card section' },
    h('h2', null, '프로그래머스 동기화 · 데이터'),
    syncStatusEl,
    field('자동 동기화', '6시간마다, 그리고 프로그래머스 페이지를 열 때 내가 푼 문제를 가져와요', switchInput('autoSync')),
    h(
      'div',
      { class: 'data-actions' },
      h(
        'button',
        {
          class: 'btn small',
          onClick: async () => {
            flash('동기화 중…');
            const res = await call('syncNow').catch((e) => ({ ok: false, error: e.message }));
            state = await loadState();
            updateSyncStatus();
            flash(res?.ok === false ? res.error ?? '동기화 실패' : state.solvedSync.message || '동기화했어요');
          },
        },
        '지금 동기화',
      ),
      h('button', { class: 'btn small', onClick: () => exportBackup() }, '백업 내보내기 (JSON)'),
      h('button', { class: 'btn small', onClick: () => fileInput.click() }, '백업 불러오기'),
      h(
        'button',
        {
          class: 'btn small danger',
          onClick: async () => {
            if (!window.confirm('풀이 기록을 모두 지울까요? 설정은 남아요. (먼저 백업을 내보내 두면 되돌릴 수 있어요)')) return;
            await act('reset', { keepSettings: true }, '기록을 초기화했어요');
          },
        },
        '기록 초기화',
      ),
      fileInput,
    ),
    h('p', { class: 'muted', style: { fontSize: '12px', margin: '12px 0 0' } }, `문제 카탈로그 ${CATALOG_META.count}문제 · ${CATALOG_META.builtAt} 기준 · 기록은 이 브라우저(chrome.storage.local)에만 저장돼요`),
  );

  return [
    h('div', null, h('h1', { class: 'page-title' }, '설정'), h('p', { class: 'page-desc' }, '바꾸면 바로 저장돼요.')),
    h('div', { class: 'settings-grid' }, h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } }, notify, topics), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } }, recommend, data)),
  ];
}

// ── 의견 보내기 ───────────────────────────────────────────
function feedbackPage() {
  const form = { kind: 'idea', message: '', replyTo: '', includeEnv: true };
  const env = {
    version: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform || navigator.platform || '',
  };
  const status = h('div', { class: 'fb-status', role: 'status', 'aria-live': 'polite' });
  const setStatus = (text, tone = '') => {
    status.textContent = text;
    status.className = `fb-status ${tone}`;
  };
  const counter = h('span', { class: 'fb-count' }, `0 / ${MAX_MESSAGE}`);
  const textarea = h('textarea', {
    rows: '7',
    maxlength: String(MAX_MESSAGE),
    'aria-label': '의견 내용',
    placeholder: '어떤 상황에서 무엇이 불편했는지, 어떤 기능이 있으면 좋을지 자유롭게 적어 주세요.',
    onInput: (e) => {
      form.message = e.target.value;
      counter.textContent = `${e.target.value.length} / ${MAX_MESSAGE}`;
    },
  });
  const email = h('input', {
    type: 'email',
    'aria-label': '답장 받을 이메일',
    placeholder: '답장 받을 이메일 (선택)',
    onInput: (e) => {
      form.replyTo = e.target.value;
    },
  });
  const kinds = h(
    'div',
    { class: 'seg', role: 'radiogroup', 'aria-label': '의견 종류' },
    KINDS.map(([k, label]) =>
      h(
        'label',
        { class: 'seg-item' },
        h('input', { type: 'radio', name: 'fb-kind', value: k, checked: form.kind === k, onChange: () => (form.kind = k) }),
        h('span', null, label),
      ),
    ),
  );
  const prepare = () => {
    const err = validateFeedback(form);
    if (err) {
      setStatus(err, 'warn');
      textarea.focus();
      return null;
    }
    return buildFeedback(form, env);
  };
  const clearForm = () => {
    textarea.value = '';
    form.message = '';
    counter.textContent = `0 / ${MAX_MESSAGE}`;
  };

  const actions = [];
  if (canSendDirect()) {
    actions.push(
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onClick: async (e) => {
            const fb = prepare();
            if (!fb) return;
            e.currentTarget.disabled = true;
            const btn = e.currentTarget;
            setStatus('보내는 중…');
            try {
              await sendDirect(fb, { replyTo: form.replyTo });
              setStatus('보냈어요! 소중한 의견 고마워요.', 'ok');
              clearForm();
            } catch (err) {
              setStatus(`보내지 못했어요(${err.message}). '메일 앱으로 보내기'나 '내용 복사'를 써 주세요.`, 'warn');
            } finally {
              btn.disabled = false;
            }
          },
        },
        '보내기',
      ),
    );
  }
  actions.push(
    h(
      'button',
      {
        class: `btn ${canSendDirect() ? '' : 'primary'}`,
        type: 'button',
        onClick: () => {
          const fb = prepare();
          if (!fb) return;
          const a = h('a', { href: mailtoUrl(fb), target: '_blank', rel: 'noopener' });
          document.body.append(a);
          a.click();
          a.remove();
          setStatus("메일 앱이 열렸어요. 안 열리면 '내용 복사'를 눌러 메일에 붙여 넣어 주세요.");
        },
      },
      '메일 앱으로 보내기',
    ),
    h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onClick: async () => {
          const fb = prepare();
          if (!fb) return;
          try {
            await navigator.clipboard.writeText(`받는 사람: ${FEEDBACK_EMAIL}\n제목: ${fb.subject}\n\n${fb.body}`);
            setStatus(`복사했어요. ${FEEDBACK_EMAIL} 로 메일을 보내 주세요.`, 'ok');
          } catch {
            setStatus('복사하지 못했어요. 내용을 직접 선택해서 복사해 주세요.', 'warn');
          }
        },
      },
      '내용 복사',
    ),
    h(
      'button',
      {
        class: 'btn ghost',
        type: 'button',
        onClick: () => {
          const fb = prepare();
          if (fb) openUrl(issueUrl(fb));
        },
      },
      'GitHub 이슈로 남기기',
    ),
  );

  return [
    h(
      'div',
      null,
      h('h1', { class: 'page-title' }, '의견 보내기'),
      h('p', { class: 'page-desc' }, '버그, 불편한 점, 있었으면 하는 기능을 알려 주세요. 개발자 메일로 전달돼요.'),
    ),
    h(
      'section',
      { class: 'card section fb' },
      h('div', { class: 'fb-row' }, h('div', { class: 'fb-label' }, '종류'), kinds),
      h('div', { class: 'fb-row col' }, h('div', { class: 'fb-label' }, '내용', counter), textarea),
      h('div', { class: 'fb-row' }, h('div', { class: 'fb-label' }, '답장'), email),
      h(
        'label',
        { class: 'fb-env' },
        h('input', { type: 'checkbox', checked: true, onChange: (e) => (form.includeEnv = e.target.checked) }),
        `확장·크롬 버전 함께 보내기 (${envLine(env)})`,
      ),
      h('div', { class: 'fb-actions' }, actions),
      status,
      h(
        'p',
        { class: 'muted fb-note' },
        canSendDirect()
          ? `'보내기'를 누르면 내용이 메일 전달 서비스(Web3Forms)를 거쳐 개발자(${FEEDBACK_EMAIL})에게 도착해요.`
          : `메일 앱이 없으면 '내용 복사' 후 ${FEEDBACK_EMAIL} 로 보내 주세요. 버튼을 누르기 전에는 아무것도 전송되지 않아요.`,
      ),
    ),
  ];
}

async function exportBackup() {
  try {
    const { state: s } = await call('export');
    const blob = new Blob([JSON.stringify({ app: 'coding-daily', exportedAt: new Date().toISOString(), state: s }, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `coding-daily-backup-${dateKey()}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash('백업 파일을 저장했어요');
  } catch (e) {
    flash(e.message);
  }
}

init();
