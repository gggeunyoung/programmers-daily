// 사용자 의견(피드백) 보내기.
// 기본: 메일 앱으로 보내기(mailto) + 내용 복사 + GitHub 이슈 — 확장이 직접 데이터를 보내지 않는다.
// 선택: WEB3FORMS_ACCESS_KEY 를 넣으면 확장 안에서 '보내기' 한 번으로 개발자 메일에 바로 도착한다
//       (https://web3forms.com 에서 받는 이메일을 입력하면 키가 메일로 온다. 이 키는 공개돼도 되는 값).
//       키를 넣으면 개인정보처리방침·스토어 데이터 공개 항목도 함께 고쳐야 한다(store/LISTING.md 참고).

export const FEEDBACK_EMAIL = 'gykim0330@naver.com';
export const WEB3FORMS_ACCESS_KEY = '';
export const WEB3FORMS_ENDPOINT = 'https://api.web3forms.com/submit';
export const ISSUES_URL = 'https://github.com/gggeunyoung/programmers-daily/issues/new';
export const MAX_MESSAGE = 2000;

export const KINDS = [
  ['bug', '버그 제보'],
  ['idea', '기능 제안'],
  ['etc', '기타 의견'],
];

export const canSendDirect = () => Boolean(WEB3FORMS_ACCESS_KEY);

/** 사용 환경 한 줄: '1.2.0 · Chrome 156 · Windows' */
export function envLine({ version = '', userAgent = '', platform = '' } = {}) {
  const chrome = /Chrome\/(\d+)/.exec(userAgent)?.[1];
  return [version && `확장 ${version}`, chrome && `Chrome ${chrome}`, platform].filter(Boolean).join(' · ');
}

/** 메일 제목·본문 만들기 */
export function buildFeedback({ kind = 'etc', message = '', replyTo = '', includeEnv = true }, env = {}) {
  const label = (KINDS.find(([k]) => k === kind) ?? KINDS[2])[1];
  const text = String(message).trim().slice(0, MAX_MESSAGE);
  const firstLine = text.split('\n')[0].slice(0, 40);
  const subject = `[1일1코 ${label}] ${firstLine}`.trim();
  const lines = [text, '', '-----', `종류: ${label}`, `답장 받을 이메일: ${replyTo.trim() || '(없음)'}`];
  if (includeEnv) lines.push(`환경: ${envLine(env) || '(알 수 없음)'}`);
  return { subject, body: lines.join('\n'), label };
}

export function validateFeedback({ message = '', replyTo = '' }) {
  if (String(message).trim().length < 5) return '내용을 조금만 더 적어 주세요(5자 이상).';
  if (replyTo.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo.trim())) return '답장 받을 이메일 형식을 확인해 주세요.';
  return null;
}

export function mailtoUrl({ subject, body }) {
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function issueUrl({ subject, body }) {
  return `${ISSUES_URL}?title=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Web3Forms 로 바로 보내기(키가 있을 때만) */
export async function sendDirect({ subject, body }, { replyTo = '', fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!canSendDirect()) throw new Error('바로 보내기가 설정되지 않았어요');
  const payload = { access_key: WEB3FORMS_ACCESS_KEY, subject, from_name: '1일1코 사용자', message: body };
  if (replyTo.trim()) payload.email = replyTo.trim();
  const res = await fetchImpl(WEB3FORMS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.message || `전송 실패(${res.status})`);
  return true;
}
