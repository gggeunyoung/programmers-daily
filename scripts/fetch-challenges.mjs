#!/usr/bin/env node
// 프로그래머스 '코딩테스트 연습' 전체 문제 목록을 공개 API에서 받아 JSON으로 저장한다.
// 사용: node scripts/fetch-challenges.mjs [출력경로=data/raw/challenges.json]
// 로그인 없이 호출하므로 status 는 전부 unsolved 로 온다(메타데이터만 쓴다).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = process.argv[2] ?? 'data/raw/challenges.json';
const BASE = 'https://school.programmers.co.kr/api/v2/school/challenges/';
const PER_PAGE = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const all = [];
let page = 1;
let totalPages = 1;
do {
  const url = `${BASE}?perPage=${PER_PAGE}&page=${page}&order=recent`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} (page ${page})`);
  const body = await res.json();
  totalPages = body.totalPages;
  for (const c of body.result) {
    all.push({
      id: c.id,
      title: c.title,
      partTitle: c.partTitle,
      level: c.level,
      finishedCount: c.finishedCount,
      acceptanceRate: c.acceptanceRate,
      openedAt: c.openedAt,
    });
  }
  console.log(`page ${page}/${totalPages}: 누적 ${all.length}`);
  page += 1;
  await sleep(700); // 서버에 부담 주지 않도록 천천히
} while (page <= totalPages);

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ fetchedAt: new Date().toISOString(), count: all.length, challenges: all }, null, 1) + '\n');
console.log(`저장: ${out} (${all.length}문제)`);
