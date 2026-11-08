import { CATALOG_META, PROBLEMS } from '../data/problems.js';

export { CATALOG_META };
export const CATALOG = PROBLEMS;

const BY_ID = new Map(PROBLEMS.map((p) => [p.id, p]));

export function getProblem(id) {
  return BY_ID.get(Number(id)) ?? null;
}

export const TIER_LABEL = ['고득점 Kit', '기출', '연습문제'];

export function tierLabel(tier) {
  return TIER_LABEL[tier] ?? '';
}
