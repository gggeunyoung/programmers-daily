// chrome.storage.local 위의 아주 작은 '데이터베이스' 계층.
// 상태 전체를 'state' 키 하나에 저장하고, 모든 쓰기를 한 줄로 세워(직렬화) 동시 요청에도 기록이 유실되지 않게 한다.
// area 는 chrome.storage.local 과 같은 {get, set} 을 가진 객체면 된다(테스트에서는 메모리 구현을 넣는다).
import { migrate } from './state.js';

export const STATE_KEY = 'state';

export function createStore(area) {
  let chain = Promise.resolve();

  async function read() {
    const got = await area.get(STATE_KEY);
    return migrate(got?.[STATE_KEY]);
  }

  /** mutator(state) 가 state 를 고치면 저장한다. mutator 의 반환값을 돌려준다 */
  function update(mutator) {
    const run = chain.then(async () => {
      const state = await read();
      const result = await mutator(state);
      await area.set({ [STATE_KEY]: state });
      return result;
    });
    chain = run.catch(() => {});
    return run;
  }

  /** 상태 통째로 바꾸기(가져오기·초기화) */
  function replace(next) {
    return update((state) => {
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, migrate(next));
    });
  }

  return { read, update, replace };
}

/** 테스트·개발 하네스용 메모리 저장소 */
export function memoryArea(initial = {}) {
  let data = structuredClone(initial);
  return {
    async get(key) {
      if (key == null) return structuredClone(data);
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      data = { ...data, ...structuredClone(obj) };
    },
    dump() {
      return structuredClone(data);
    },
  };
}
