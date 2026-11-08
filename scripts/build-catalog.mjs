#!/usr/bin/env node
// data/catalog.source.mjs(유형 태그) + 프로그래머스 API 덤프(제목·레벨·정답률) → src/data/problems.js
// 사용: node scripts/build-catalog.mjs data/raw/challenges.json
// 태그한 문제 ID가 덤프에 없으면 실패한다(문제 ID 오타·삭제된 문제를 막기 위함).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TAGS } from '../data/catalog.source.mjs';
import { TOPICS, TOPIC_KEYS } from '../src/lib/topics.js';

const dumpPath = process.argv[2] ?? 'data/raw/challenges.json';
const OUT = 'src/data/problems.js';

const KIT_PARTS = new Set([
  '해시', '스택/큐', '힙(Heap)', '정렬', '완전탐색', '탐욕법(Greedy)',
  '동적계획법(Dynamic Programming)', '깊이/너비 우선 탐색(DFS/BFS)', '이분탐색', '그래프',
]);
const EXAM_PATTERN = /KAKAO|카카오|PCCP|PCCE|현대모비스|Dev-Matching|코드챌린지|팁스타운/;

// tier 0: 고득점 Kit, 1: 기업·인증 기출, 2: 연습문제·챌린지
function tierOf(part) {
  if (KIT_PARTS.has(part)) return 0;
  if (EXAM_PATTERN.test(part)) return 1;
  return 2;
}

const dump = JSON.parse(await readFile(dumpPath, 'utf8'));
const byId = new Map(dump.challenges.map((c) => [c.id, c]));

const errors = [];
const seen = new Set();
const problems = [];
for (const [id, tagStr] of TAGS) {
  if (seen.has(id)) errors.push(`중복 ID: ${id}`);
  seen.add(id);
  const topics = tagStr.split(',').map((s) => s.trim()).filter(Boolean);
  for (const t of topics) if (!TOPIC_KEYS.includes(t)) errors.push(`${id}: 알 수 없는 유형 '${t}'`);
  const c = byId.get(id);
  if (!c) {
    errors.push(`${id}: 프로그래머스 목록에 없는 문제 ID`);
    continue;
  }
  if (c.level < 1) errors.push(`${id} ${c.title}: Lv.0(입문) 문제는 넣지 않는다`);
  problems.push({
    id,
    title: c.title.trim(),
    level: c.level,
    topics,
    part: c.partTitle,
    tier: tierOf(c.partTitle),
    rate: c.acceptanceRate,
  });
}

if (errors.length) {
  console.error('카탈로그 검증 실패:\n - ' + errors.join('\n - '));
  process.exit(1);
}

problems.sort((a, b) => a.tier - b.tier || a.level - b.level || a.id - b.id);

const lines = problems.map((p) => '  ' + JSON.stringify(p) + ',');
const meta = {
  builtAt: new Date().toLocaleDateString('sv-SE'), // 현지 날짜 YYYY-MM-DD
  fetchedAt: dump.fetchedAt,
  count: problems.length,
};
const body = `// 자동 생성 파일 — 직접 고치지 말 것.
// 원본: data/catalog.source.mjs (유형 태그) + 프로그래머스 공개 API (제목·레벨·정답률)
// 다시 만들기: npm run fetch:challenges && npm run build:catalog
export const CATALOG_META = ${JSON.stringify(meta)};

export const PROBLEMS = [
${lines.join('\n')}
];
`;
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, body);

// 유형 × 레벨 분포 출력
console.log(`생성: ${OUT} (${problems.length}문제)`);
const table = TOPICS.map((t) => {
  const lv = [0, 0, 0, 0, 0, 0];
  let primary = 0;
  for (const p of problems) {
    if (!p.topics.includes(t.key)) continue;
    lv[p.level] += 1;
    if (p.topics[0] === t.key) primary += 1;
  }
  return `${t.short.padEnd(8)} 주${String(primary).padStart(3)}  L1:${lv[1]} L2:${lv[2]} L3:${lv[3]} L4:${lv[4]} L5:${lv[5]}`;
});
console.log(table.join('\n'));
