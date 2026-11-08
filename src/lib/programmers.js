// 프로그래머스 연동: 문제 URL, '해결한 문제' 목록 동기화, 로그인 확인.
// API 는 코딩테스트 연습 목록 페이지가 쓰는 공개 엔드포인트다. statuses[]=solved 필터는 로그인한 사용자 기준으로 동작한다.

export const ORIGIN = 'https://school.programmers.co.kr';
export const LESSON_PATH_RE = /\/learn\/courses\/30\/lessons\/(\d+)/;

export function problemUrl(id, language = '') {
  const url = `${ORIGIN}/learn/courses/30/lessons/${id}`;
  return language ? `${url}?language=${encodeURIComponent(language)}` : url;
}

export function lessonIdFromUrl(url) {
  const m = LESSON_PATH_RE.exec(String(url ?? ''));
  return m ? Number(m[1]) : null;
}

export function solvedListUrl(page, perPage = 100) {
  return `${ORIGIN}/api/v2/school/challenges/?perPage=${perPage}&page=${page}&order=recent&statuses%5B%5D=solved`;
}

/**
 * 로그인한 사용자가 해결한 문제 목록을 전부 가져온다.
 * @returns {Promise<{solved:{id,title,level,part}[], totalEntries:number}>}
 */
export async function fetchSolvedList({ fetchImpl = fetch, credentials = 'include', maxPages = 30 } = {}) {
  const solved = [];
  let page = 1;
  let totalPages = 1;
  let totalEntries = 0;
  do {
    const res = await fetchImpl(solvedListUrl(page), { credentials, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`프로그래머스 응답 ${res.status}`);
    const body = await res.json();
    totalPages = Number(body.totalPages) || 0;
    totalEntries = Number(body.totalEntries) || 0;
    for (const c of body.result ?? []) {
      if (c.status && c.status !== 'solved') continue; // 필터가 무시되는 경우 대비
      solved.push({ id: c.id, title: c.title, level: c.level, part: c.partTitle });
    }
    page += 1;
  } while (page <= totalPages && page <= maxPages);
  return { solved, totalEntries };
}

/** 문제 페이지의 data-user-signed-in 속성으로 로그인 여부 확인. 모르면 null */
export async function checkSignedIn({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${ORIGIN}/learn/courses/30/lessons/1845`, { credentials: 'include' });
  if (!res.ok) return null;
  const html = await res.text();
  const m = /data-user-signed-in="(true|false)"/.exec(html);
  return m ? m[1] === 'true' : null;
}
