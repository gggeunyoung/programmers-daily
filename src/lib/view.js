// 팝업·대시보드가 그리는 화면용 데이터(뷰 모델). 순수 함수라 테스트·하네스에서 그대로 쓴다.
import { computeTopicStats, rankWeakTopics, reviewQueue, summarize } from './analytics.js';
import { getProblem, tierLabel } from './catalog.js';
import { addDays, dateKey, diffDays, formatDuration, parseKey } from './dates.js';
import { pendingToday } from './engine.js';
import { problemUrl } from './programmers.js';
import { MAX_REROLLS_PER_DAY } from './recommender.js';
import { topicShort } from './topics.js';

export const STATUS_META = {
  pending: { label: '도전 중', tone: 'info', icon: '●' },
  solved: { label: '해결', tone: 'good', icon: '✓' },
  missed: { label: '복습 대기', tone: 'serious', icon: '↻' },
  dropped: { label: '그만 봄', tone: 'muted', icon: '–' },
  tracked: { label: '스스로 시도', tone: 'muted', icon: '·' },
  imported: { label: '해결(가져옴)', tone: 'good', icon: '✓' },
};

export const SOLVED_VIA_LABEL = { detect: '채점 감지', sync: '프로그래머스 동기화', manual: '직접 체크' };

export function problemView(state, id) {
  const pid = Number(id);
  const r = state.records[pid] ?? null;
  const p = getProblem(pid);
  const meta = state.solvedSync?.meta?.[pid];
  const imported = (state.solvedSync?.ids ?? []).map(Number).includes(pid);
  return {
    id: pid,
    title: r?.title ?? p?.title ?? meta?.title ?? `문제 ${pid}`,
    level: r?.level ?? p?.level ?? meta?.level ?? null,
    topics: r?.topics?.length ? r.topics : p?.topics ?? [],
    part: r?.part || p?.part || meta?.part || '',
    tier: p ? tierLabel(p.tier) : '',
    rate: p?.rate ?? null,
    url: problemUrl(pid, state.settings?.language ?? ''),
    record: r,
    status: r?.status ?? (imported ? 'imported' : null),
  };
}

/** '오답 2회 · 34분 만에' 같은 한 줄 요약 */
export function attemptSummary(r) {
  if (!r) return '';
  const parts = [];
  if (r.status === 'solved') {
    if (r.wrong) parts.push(`오답 ${r.wrong}회 후 정답`);
    else if (r.solvedVia === 'detect') parts.push('한 번에 정답');
    if (r.missCount === 0 && r.firstOpenedAt && r.solvedAt > r.firstOpenedAt) parts.push(`${formatDuration(r.solvedAt - r.firstOpenedAt)} 만에`);
    if (r.missCount > 0) parts.push(`${r.missCount}번 놓친 뒤 해결`);
    if (r.solvedVia && r.solvedVia !== 'detect') parts.push(SOLVED_VIA_LABEL[r.solvedVia]);
  } else {
    if (r.wrong) parts.push(`오답 ${r.wrong}회`);
    if (r.missCount) parts.push(`${r.missCount}번 놓침`);
  }
  return parts.join(' · ');
}

export function todayView(state, today = dateKey()) {
  const day = state.days[today] ?? null;
  const daily = day?.problemId
    ? { ...problemView(state, day.problemId), topic: day.topic, targetLevel: day.targetLevel, relaxed: day.relaxed }
    : null;
  const reviews = (day?.reviewIds ?? []).map((id) => problemView(state, id));
  const stats = computeTopicStats(state, today);
  return {
    today,
    day,
    daily,
    reviews,
    rerollsLeft: day ? Math.max(0, MAX_REROLLS_PER_DAY - (day.rerolls ?? 0)) : 0,
    summary: summarize(state, today),
    stats,
    weak: rankWeakTopics(stats).slice(0, 3),
    queue: reviewQueue(state, today),
    sync: state.solvedSync,
    settings: state.settings,
  };
}

/** 기록 탭: 내 기록(추천·스스로 푼 문제) */
export function historyRows(state, { status = 'all', topic = 'all', q = '' } = {}) {
  const query = q.trim().toLowerCase();
  return Object.values(state.records)
    .map((r) => {
      const lastAt = Math.max(r.solvedAt ?? 0, r.lastSubmitAt ?? 0, r.updatedAt ?? 0, r.createdAt ?? 0);
      return {
        ...problemView(state, r.id),
        firstDay: r.recommendedOn?.[0] ?? (r.createdAt ? dateKey(r.createdAt) : null),
        lastAt,
        summary: attemptSummary(r),
        source: r.origin === 'daily' ? '추천' : '스스로',
      };
    })
    .filter((row) => {
      if (status !== 'all' && row.status !== status) return false;
      if (topic !== 'all' && !row.topics.includes(topic)) return false;
      if (query && !(`${row.title} ${row.id} ${row.part}`.toLowerCase().includes(query))) return false;
      return true;
    })
    .sort((a, b) => (b.firstDay ?? '').localeCompare(a.firstDay ?? '') || b.lastAt - a.lastAt || b.id - a.id);
}

/** 프로그래머스에서 가져온 해결 목록 중 내 기록에 없는 것 */
export function importedRows(state) {
  return (state.solvedSync?.ids ?? [])
    .map(Number)
    .filter((id) => !state.records[id])
    .map((id) => problemView(state, id))
    .sort((a, b) => (b.level ?? 0) - (a.level ?? 0) || a.id - b.id);
}

/** 잔디: weeks 개의 열(일~토) */
export function heatmapWeeks(byDay, today, weeks = 20) {
  const dow = parseKey(today).getDay();
  const firstSunday = addDays(today, -dow - (weeks - 1) * 7);
  const cols = [];
  for (let w = 0; w < weeks; w += 1) {
    const col = [];
    for (let d = 0; d < 7; d += 1) {
      const key = addDays(firstSunday, w * 7 + d);
      col.push({ key, count: byDay[key] ?? 0, future: key > today });
    }
    cols.push(col);
  }
  return cols;
}

export function levelLabel(level) {
  return level == null ? 'Lv.?' : `Lv.${level}`;
}

export function topicChips(topics) {
  return (topics ?? []).map((t) => topicShort(t));
}

/** 팝업에 보여 줄 '다음 알림' 안내 */
export function nextAlarmText(state, today, now = Date.now()) {
  const s = state.settings;
  const day = state.days[today];
  if (!s.enabled) return '알림 꺼짐';
  if (!day) return '';
  if (!pendingToday(state, today).any) return '오늘 알림 끝';
  if (day.muted) return '오늘은 알림 그만';
  const d = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const next = (s.notifyTimes ?? []).find((t) => t > hm && !(day.sentSlots ?? []).includes(t));
  return next ? `다음 알림 ${next}` : '오늘 알림 끝';
}

export function reviewHint(r, today) {
  if (!r?.nextReviewOn) return '';
  const n = diffDays(today, r.nextReviewOn);
  if (n <= 0) return '오늘 복습';
  if (n === 1) return '내일 복습';
  return `${n}일 뒤 복습`;
}
