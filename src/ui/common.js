// 팝업·대시보드 공용 조각
import { STATUS_META } from '../lib/view.js';
import { h } from './dom.js';

export function statusBadge(status, labelOverride) {
  const meta = STATUS_META[status] ?? { label: '-', tone: 'muted', icon: '·' };
  return h('span', { class: `status ${meta.tone}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }, meta.icon), labelOverride ?? meta.label);
}

let toastTimer = null;
export function flash(message) {
  let el = document.querySelector('.toast-line');
  if (!el) {
    el = h('div', { class: 'toast-line', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

export const REASON_TEXT = {
  limit: '오늘은 더 바꿀 수 없어요(하루 3번)',
  solved: '이미 푼 문제는 바꿀 수 없어요',
  'no-candidate': '이 유형에 남은 문제가 없어요',
  'no-problem': '오늘의 문제가 아직 없어요',
};
