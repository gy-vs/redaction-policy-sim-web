import type {Policy} from './domain';

/**
 * 规范化策略文本：与对象键序、空白无关，但保留规则数组顺序
 * （顺序即优先级，是策略语义的一部分）。
 * 服务端用它计算草稿哈希；前端用它比较“当前草稿”与“上次模拟快照”，
 * 任何字段变化（含重排）都会立即产生不同文本，从而把旧模拟结果标记为过期。
 */
export function canonicalizePolicy(policy: Policy): string {
  const rules = policy.rules.map(rule => ({
    id: rule.id,
    name: rule.name,
    detector: rule.detector,
    threshold: rule.threshold,
    strategy: rule.strategy,
    base: rule.base ?? null,
    replacement: rule.replacement,
  }));
  return JSON.stringify({rules});
}
