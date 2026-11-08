// 팝업·대시보드 → 서비스 워커 요청. 모든 쓰기는 서비스 워커 한 곳에서 처리한다.
import { migrate } from '../lib/state.js';

/** 서비스 워커에 요청하고 결과(data)를 돌려준다. data 안의 ok:false/reason 은 호출한 쪽이 판단한다 */
export async function call(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? '백그라운드가 응답하지 않아요. 확장을 다시 로드해 보세요.');
  return res.data ?? {};
}

export async function loadState() {
  const { state } = await call('getState');
  return migrate(state);
}

/** 저장소가 바뀌면(다른 탭에서 풀이 감지 등) 다시 그린다 */
export function onStateChange(fn) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.state?.newValue) fn(migrate(changes.state.newValue));
  });
}

export function openUrl(url) {
  return chrome.tabs.create({ url });
}

export function openDashboard(hash = '') {
  return chrome.tabs.create({ url: chrome.runtime.getURL(`src/dashboard/dashboard.html${hash}`) });
}
