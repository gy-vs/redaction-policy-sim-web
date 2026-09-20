import {createHash} from 'node:crypto';
import type {
  CompiledPolicy,
  CompiledRule,
  CompileIssue,
  Policy,
  Rule,
} from './domain';
import {isDetectorId} from './domain';
import {canonicalizePolicy} from './canonical';

export {canonicalizePolicy};

export function hashPolicy(policy: Policy): string {
  return createHash('sha256').update(canonicalizePolicy(policy)).digest('hex').slice(0, 16);
}

/**
 * 编译策略：
 *  - invalid_reference   引用了不存在的规则 id / 未知检测器 / 规则 id 重复
 *  - circular_derivation 派生链存在环
 *  - unreachable_rule    祖先链上某条规则永不触发（阈值 > 1），导致派生规则永远不可达
 *  - invalid_threshold   阈值不在 [0,1]
 *  - missing_replacement redact 策略缺少替换文案
 * 任何 issue 都会阻止保存；编译产物仍返回给前端用于行内提示。
 */
export function compilePolicy(policy: Policy): CompiledPolicy {
  const issues: CompileIssue[] = [];
  const byId = new Map<string, Rule>();
  for (const rule of policy.rules) {
    if (byId.has(rule.id)) {
      issues.push({code: 'invalid_reference', ruleId: rule.id, message: `规则 id "${rule.id}" 重复`});
    }
    byId.set(rule.id, rule);
  }

  for (const rule of policy.rules) {
    if (!isDetectorId(rule.detector)) {
      issues.push({code: 'invalid_reference', ruleId: rule.id, message: `未知检测器 "${rule.detector}"`});
    }
    if (!(rule.threshold >= 0 && rule.threshold <= 1)) {
      issues.push({code: 'invalid_threshold', ruleId: rule.id, message: `阈值 ${rule.threshold} 超出 [0,1] 区间`});
    }
    if (rule.strategy === 'redact' && rule.replacement.trim() === '') {
      issues.push({code: 'missing_replacement', ruleId: rule.id, message: 'redact 策略必须提供替换文案'});
    }
    if (rule.base !== null && !byId.has(rule.base)) {
      issues.push({code: 'invalid_reference', ruleId: rule.id, message: `引用了不存在的规则 "${rule.base}"`});
    }
  }

  // 派生链解析：沿 base 指针向上走，seen 集合检测回环
  const resolveChain = (rule: Rule): {chain: string[]; circular: boolean} => {
    const chain: string[] = [];
    const seen = new Set<string>([rule.id]);
    let cursor: Rule | undefined = rule;
    while (cursor && cursor.base !== null) {
      const next = cursor.base;
      if (!byId.has(next)) return {chain, circular: false}; // 无效引用已单独报告
      if (seen.has(next)) {
        chain.push(next);
        return {chain, circular: true};
      }
      seen.add(next);
      chain.push(next);
      cursor = byId.get(next);
    }
    return {chain, circular: false};
  };

  const chains = new Map<string, string[]>();
  for (const rule of policy.rules) {
    if (rule.base === null) {
      chains.set(rule.id, []);
      continue;
    }
    const {chain, circular} = resolveChain(rule);
    if (circular) {
      issues.push({
        code: 'circular_derivation',
        ruleId: rule.id,
        message: `派生链存在循环：${[rule.id, ...chain].join(' → ')}`,
      });
      chains.set(rule.id, []);
      continue;
    }
    chains.set(rule.id, chain);
  }

  // 不可达检测：祖先阈值 > 1（永不触发）时，其所有派生后代永远不可达
  for (const rule of policy.rules) {
    const chain = chains.get(rule.id) ?? [];
    const blocker = chain
      .map(id => byId.get(id)!)
      .find(ancestor => ancestor.threshold > 1);
    if (blocker) {
      issues.push({
        code: 'unreachable_rule',
        ruleId: rule.id,
        message: `规则永远不可达：祖先规则 "${blocker.id}" 的阈值 ${blocker.threshold} > 1，永不触发`,
      });
    }
  }

  const compiledRules: CompiledRule[] = policy.rules.map((rule, index) => ({
    ...rule,
    order: index,
    chain: chains.get(rule.id) ?? [],
  }));

  return {hash: hashPolicy(policy), rules: compiledRules, issues};
}
