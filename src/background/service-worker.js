// MV3 서비스 워커 진입점. 리스너는 반드시 최상위에서 동기적으로 등록해야 깨어날 때 이벤트를 받는다.
import { createStore } from '../lib/store.js';
import { createService } from './service.js';

const service = createService({ store: createStore(chrome.storage.local), chrome });

chrome.runtime.onInstalled.addListener((details) => {
  service.onInstalled(details).catch((e) => console.error('[1일1코] 설치 처리 실패', e));
});

chrome.runtime.onStartup.addListener(() => {
  service.onStartup().catch((e) => console.error('[1일1코] 시작 처리 실패', e));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  service.onAlarm(alarm).catch((e) => console.error('[1일1코] 알람 처리 실패', e));
});

chrome.notifications.onClicked.addListener((id) => {
  service.onNotificationClicked(id).catch((e) => console.error(e));
});

chrome.notifications.onButtonClicked.addListener((id, index) => {
  service.onNotificationButton(id, index).catch((e) => console.error(e));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 전송 성공 여부(ok)와 도메인 결과(data)를 분리: data 안에도 ok/reason 이 있을 수 있다
  service.handleMessage(msg).then(
    (data) => sendResponse({ ok: true, data: data ?? {} }),
    (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
  );
  return true; // 비동기 응답
});

// 개발·E2E 점검용: 서비스 워커 콘솔에서 self.codingDaily.tick() 등을 직접 호출할 수 있다
self.codingDaily = service;
