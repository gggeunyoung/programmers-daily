import { dateKey, prettyDate, relativeDay } from '../lib/dates.js';
import { topicName, topicShort } from '../lib/topics.js';
import { attemptSummary, levelLabel, nextAlarmText, reviewHint, todayView } from '../lib/view.js';
import { call, loadState, onStateChange, openDashboard, openUrl } from '../ui/api.js';
import { flash, REASON_TEXT, statusBadge } from '../ui/common.js';
import { h, mount } from '../ui/dom.js';

const app = document.getElementById('app');
let state = null;

async function init() {
  try {
    state = await loadState();
    render();
  } catch (e) {
    mount(app, h('div', { class: 'empty' }, `불러오지 못했어요: ${e.message}`));
  }
  onStateChange((s) => {
    state = s;
    render();
  });
}

function go(url) {
  openUrl(url);
  window.close();
}

async function act(type, payload, okMessage) {
  try {
    const res = await call(type, payload);
    if (res.ok === false || res.reason) {
      flash(REASON_TEXT[res.reason] ?? '처리하지 못했어요');
      return;
    }
    state = await loadState();
    render();
    if (okMessage) flash(okMessage);
  } catch (e) {
    flash(e.message);
  }
}

function render() {
  const v = todayView(state, dateKey());
  mount(app, header(v), todayCard(v), reviews(v), weak(v), footer(v));
}

function header(v) {
  const s = v.summary;
  const bits = [];
  if (s.streak) bits.push(h('span', null, '🔥 ', h('b', null, `${s.streak}일`), ' 연속'));
  bits.push(h('span', null, '이번 달 ', h('b', null, `${s.solvedThisMonth}`), '문제'));
  if (s.solvedAll) bits.push(h('span', null, '전체 ', h('b', null, `${s.solvedAll}`), '문제 해결'));
  return [
    h(
      'header',
      { class: 'top' },
      h('div', { class: 'brand' }, h('img', { src: '../../icons/icon32.png', alt: '' }), '1일1코'),
      h('div', { class: 'date' }, prettyDate(v.today)),
    ),
    h('div', { class: 'streakline' }, ...bits.flatMap((b, i) => (i ? [' · ', b] : [b]))),
  ];
}

function todayCard(v) {
  const d = v.daily;
  if (!d) {
    return h(
      'section',
      { class: 'today card' },
      h('div', { class: 'eyebrow' }, '오늘의 문제'),
      h('p', { class: 'sub' }, '추천할 문제가 없어요. 설정에서 난이도나 유형 범위를 넓혀 보세요.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onClick: () => openDashboard('#settings') }, '설정 열기')),
    );
  }
  const r = d.record;
  const solved = d.status === 'solved';
  const resultText = solved
    ? attemptSummary(r) || '해결했어요'
    : r?.wrong
      ? `오답 ${r.wrong}회 — 정답이면 자동 체크돼요`
      : '제출해서 정답이면 자동으로 체크돼요';
  // 안내 문구와 '다음 알림'을 한 줄에(팝업 높이 600px 안에 들도록)
  const result = h(
    'div',
    { class: 'result' },
    h('span', { class: solved || r?.wrong ? '' : 'muted' }, resultText),
    h('span', { class: 'alarm' }, '⏰ ', nextAlarmText(state, v.today)),
  );

  const actions = [
    h('button', { class: `btn ${solved ? '' : 'primary'}`, onClick: () => go(d.url) }, solved ? '다시 보기' : '문제 풀러 가기 →'),
  ];
  if (!solved) {
    actions.push(
      h(
        'button',
        {
          class: 'btn ghost small',
          title: `같은 유형의 다른 문제로 바꿔요 (오늘 ${v.rerollsLeft}번 남음)`,
          disabled: v.rerollsLeft <= 0,
          onClick: () => act('reroll', {}, '다른 문제로 바꿨어요'),
        },
        '바꾸기',
      ),
      h(
        'button',
        {
          class: 'btn ghost small',
          title: '자동 감지가 안 됐을 때 직접 체크',
          onClick: () => act('manual', { id: d.id, action: 'solved' }, '해결로 기록했어요'),
        },
        '풀었어요',
      ),
    );
  } else if (r?.solvedVia === 'manual') {
    actions.push(h('button', { class: 'btn ghost small', onClick: () => act('manual', { id: d.id, action: 'unsolve' }, '되돌렸어요') }, '되돌리기'));
  }

  return h(
    'section',
    { class: 'today card' },
    h('div', { class: 'eyebrow-row' }, h('span', { class: 'eyebrow' }, '오늘의 문제'), statusBadge(d.status, solved ? '해결!' : undefined)),
    h(
      'div',
      { class: 'chips' },
      h('span', { class: 'chip accent' }, topicName(d.topic)),
      h('span', { class: 'chip' }, levelLabel(d.level)),
      d.tier && h('span', { class: 'chip outline' }, d.tier),
    ),
    h('h2', { class: 'title' }, d.title),
    h('div', { class: 'meta' }, [d.part, d.rate != null ? `정답률 ${d.rate}%` : null].filter(Boolean).join(' · ')),
    d.relaxed && h('div', { class: 'note' }, '설정한 난이도 범위의 문제를 다 풀어서 범위 밖에서 골랐어요.'),
    result,
    h('div', { class: 'actions' }, actions),
  );
}

function reviews(v) {
  const today = v.reviews;
  const waiting = v.queue.filter((r) => !today.some((t) => t.id === r.id));
  if (!today.length && !waiting.length) return null;
  const next = waiting[0];
  return h(
    'section',
    { class: 'block' },
    h(
      'h3',
      null,
      '다시 도전',
      today.length ? h('span', { class: 'count' }, String(today.filter((x) => x.status === 'pending').length || '✓')) : null,
      h('span', { class: 'hint' }, waiting.length ? `대기 ${waiting.length}문제 · 다음 ${relativeDay(next.nextReviewOn, v.today)}` : ''),
    ),
    today.length
      ? h(
          'ul',
          { class: 'list card' },
          today.map((p) =>
            h(
              'li',
              { class: 'row' },
              h(
                'div',
                { class: 'row-main' },
                h('a', { class: 'row-title', onClick: () => go(p.url) }, p.title),
                h('div', { class: 'row-sub' }, `${topicShort(p.topics[0])} · ${levelLabel(p.level)} · ${p.record?.missCount ?? 0}번 놓침`),
              ),
              p.status === 'solved' ? statusBadge('solved') : h('button', { class: 'btn small', onClick: () => go(p.url) }, '풀기'),
            ),
          ),
        )
      : h('div', { class: 'row-sub' }, `오늘은 복습할 문제가 없어요. (${reviewHint(next, v.today)})`),
  );
}

function weak(v) {
  const items = v.weak;
  const body = items.length
    ? [
        ...items.map((st) =>
          h(
            'div',
            { class: 'weak-row', title: `${st.name}: 약점 지수 ${st.score}` },
            h('span', { class: 'name' }, st.short),
            h('div', { class: 'weak-track' }, h('div', { class: 'weak-fill', style: { width: `${Math.max(4, st.score)}%` } })),
            h('span', { class: 'val' }, String(st.score)),
          ),
        ),
        h('div', { class: 'caption' }, '약점 지수 0~100 · 높을수록 더 자주 추천돼요'),
      ]
    : [h('div', { class: 'caption' }, '추천 문제를 3개쯤 풀면 약한 유형을 알려드려요.')];
  return h('section', { class: 'block' }, h('h3', null, '약한 유형'), h('div', { class: 'weak card' }, body));
}

function footer(v) {
  const sync = v.sync;
  const syncText = sync.ok === false ? sync.message : sync.at ? `동기화 ${relativeTime(sync.at)} · ${sync.ids.length}문제` : '';
  return h(
    'footer',
    { class: 'foot' },
    h('button', { class: 'btn small', onClick: () => openDashboard('#overview') }, '대시보드'),
    h('button', { class: 'btn small ghost', onClick: () => openDashboard('#settings') }, '설정'),
    h('button', { class: 'btn small ghost', onClick: () => openDashboard('#feedback') }, '의견 보내기'),
    h('span', { class: `sync ${sync.ok === false ? 'warn' : ''}`, title: sync.message || '' }, syncText),
  );
}

function relativeTime(t) {
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.round(hr / 24)}일 전`;
}

init();
