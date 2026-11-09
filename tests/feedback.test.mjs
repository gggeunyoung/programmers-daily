import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFeedback, envLine, FEEDBACK_EMAIL, issueUrl, mailtoUrl, validateFeedback } from '../src/lib/feedback.js';

test('의견 메일: 제목·본문·환경 정보', () => {
  const env = { version: '1.2.0', userAgent: 'Mozilla/5.0 ... Chrome/156.0.8078.80 Safari/537.36', platform: 'Windows' };
  assert.equal(envLine(env), '확장 1.2.0 · Chrome 156 · Windows');
  const fb = buildFeedback({ kind: 'idea', message: '다크 모드 알림도 있으면 좋겠어요\n두 번째 줄', replyTo: 'me@example.com' }, env);
  assert.equal(fb.subject, '[1일1코 기능 제안] 다크 모드 알림도 있으면 좋겠어요');
  assert.match(fb.body, /두 번째 줄/);
  assert.match(fb.body, /답장 받을 이메일: me@example.com/);
  assert.match(fb.body, /환경: 확장 1.2.0 · Chrome 156 · Windows/);
  const noEnv = buildFeedback({ kind: 'bug', message: '알림이 안 와요', includeEnv: false }, env);
  assert.ok(!noEnv.body.includes('환경:'));
});

test('의견 메일: 검증·mailto·이슈 링크', () => {
  assert.ok(validateFeedback({ message: '짧음' }));
  assert.ok(validateFeedback({ message: '충분히 긴 의견입니다', replyTo: 'not-an-email' }));
  assert.equal(validateFeedback({ message: '충분히 긴 의견입니다', replyTo: '' }), null);
  const fb = buildFeedback({ kind: 'bug', message: '알림이 두 번 와요 & 문제가 바뀌어요' });
  const url = mailtoUrl(fb);
  assert.ok(url.startsWith(`mailto:${FEEDBACK_EMAIL}?subject=`));
  assert.ok(url.includes(encodeURIComponent('& 문제가')));
  assert.ok(issueUrl(fb).includes('/issues/new?title='));
});
