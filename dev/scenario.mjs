// 데모·스크린샷용: 사람이 몇 주 동안 쓴 것처럼 기록을 만든다(엔진 함수를 그대로 사용).
// 실제 알림·감지 경로가 아니라 같은 상태 전이를 빠르게 재생하는 것이다.
import { CATALOG } from '../src/lib/catalog.js';
import { addDays, atTime, dateKey } from '../src/lib/dates.js';
import { applySync, prepare, recordOpen, recordSubmission } from '../src/lib/engine.js';
import { seededRandom } from '../src/lib/recommender.js';
import { createInitialState } from '../src/lib/state.js';

// 유형별 '실력'(그날 풀 확률). DP·그리디·그래프가 약한 사람을 가정
const SKILL = {
  hash: 0.92, string: 0.88, sort: 0.85, stack: 0.8, math: 0.75, impl: 0.66, bfs: 0.68,
  brute: 0.62, heap: 0.6, twoptr: 0.55, bsearch: 0.5, graph: 0.42, greedy: 0.38, dp: 0.3,
};

const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

export function buildDemoState({ days = 60, today = dateKey(), seed = 'demo-2026' } = {}) {
  const rng = seededRandom(seed);
  const start = addDays(today, -days);
  const s = createInitialState(atTime(start, '08:00'));

  // 설치 직후 동기화: 예전에 푼 쉬운 문제들
  const before = CATALOG.filter((p) => p.level === 1 || (p.level === 2 && p.tier === 0 && rng() < 0.4)).map((p) => ({ id: p.id }));
  applySync(s, before.slice(0, 38), atTime(start, '08:05'));

  for (let i = 0; i < days; i += 1) {
    const day = addDays(start, i);
    const recent = days - i <= 7; // 최근 일주일은 꾸준히
    if (!recent && rng() < 0.07) continue; // 크롬을 안 켠 날
    prepare(s, atTime(day, '09:00'));
    const d = s.days[day];
    const items = [d.problemId, ...(d.reviewIds ?? [])].filter(Boolean);
    for (const id of items) {
      const r = s.records[id];
      if (!r || r.status !== 'pending') continue;
      const ago = days - i;
      if (id === d.problemId && (ago === 3 || ago === 6)) {
        // 열어서 한 번 틀리고 못 푼 날 → 오늘 복습으로 돌아온다
        const at = atTime(day, '21:00');
        recordOpen(s, { id, at });
        recordSubmission(s, { id, passed: false, at: at + 20 * 60_000 });
        continue;
      }
      if (recent && id !== d.problemId) continue; // 최근 복습은 아직 손대지 않음
      if (!recent && rng() < 0.08) continue; // 바빠서 열어보지도 못한 날
      const skill = SKILL[r.topics[0]] ?? 0.5;
      const chance = skill - ((r.level ?? 2) - 2) * 0.1 + (r.missCount ? 0.1 : 0) + (recent ? 0.25 : 0);
      const openAt = atTime(day, hhmm(19 + Math.floor(rng() * 3), Math.floor(rng() * 50)));
      recordOpen(s, { id, at: openAt });
      const solves = rng() < chance;
      const wrongs = solves ? (rng() < skill ? 0 : 1 + Math.floor(rng() * 2)) : 1 + Math.floor(rng() * 2);
      for (let k = 0; k < wrongs; k += 1) recordSubmission(s, { id, passed: false, at: openAt + (k + 1) * 7 * 60_000 });
      if (solves) recordSubmission(s, { id, passed: true, at: openAt + (wrongs + 1) * 9 * 60_000 + Math.floor(rng() * 15) * 60_000 });
    }
    // 가끔 추천 밖 문제도 스스로 푼다
    if (rng() < 0.15) {
      const p = CATALOG[Math.floor(rng() * CATALOG.length)];
      if (!s.records[p.id] && !s.solvedSync.ids.includes(p.id)) {
        const at = atTime(day, '22:10');
        recordOpen(s, { id: p.id, at });
        recordSubmission(s, { id: p.id, passed: rng() < 0.7, at: at + 25 * 60_000 });
      }
    }
  }
  // 오늘: 추천만 받은 상태
  prepare(s, atTime(today, '09:00'));
  s.days[today].notifiedAt = atTime(today, '09:00');
  return s;
}
