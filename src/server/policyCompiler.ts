import {createHash} from 'node:crypto';
import type {
  ActiveRule,
  Compilation,
  CompileDiagnostic,
  PolicyDraft,
  ReplacementStrategy,
} from '../shared/types.js';

export const STRATEGIES: ReplacementStrategy[] = ['mask', 'label', 'redact', 'hash', 'keep'];

/** 内置检测器 id（见 detectorEngine.ts） */
export const BUILTIN_DETECTORS: { id: string; label: string }[] = [
  {id: 'email', label: '电子邮箱'},
  {id: 'phone', label: '电话号码'},
  {id: 'id_card', label: '身份证号'},
  {id: 'bank_card', label: '银行卡号'},
  {id: 'name_cn', label: '中文姓名'},
  {id: 'address', label: '地址关键词'},
  {id: 'secret', label: '密钥/口令'},
];

function isFiniteNumber(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 规范化草稿：键排序、去掉空白波动，保证同样语义的草稿哈希一致。
 * 哈希同时绑定“最终参与模拟的定义”，重排规则会改变优先级因此也会改变哈希。
 */
export function canonicalize(draft: PolicyDraft): string {
  const clean = {
    name: draft.name ?? '',
    detectors: (draft.detectors ?? []).map((d) => ({
      id: d.id,
      label: d.label,
      sources: [...d.sources].sort(),
      combine: d.combine,
      window: d.window,
    })),
    rules: (draft.rules ?? []).map((r, index) => ({
      // 顺序即优先级，必须参与哈希
      order: index,
      id: r.id,
      detectorId: r.detectorId,
      minConfidence: r.minConfidence,
      strategy: r.strategy,
      label: r.label,
      enabled: r.enabled,
    })),
  };
  return JSON.stringify(clean);
}

export function hashDraft(draft: PolicyDraft): string {
  return createHash('sha256').update(canonicalize(draft)).digest('hex').slice(0, 16);
}

/**
 * 编译策略草稿：
 *  - 无效引用：规则 / 派生检测器指向不存在的检测器
 *  - 循环派生：派生图成环（环上节点及其下游全部拒绝参与模拟）
 *  - 永远不可达：同检测器（沿派生闭包）上，靠前规则的阈值 <= 靠后规则，
 *    且启用、替换策略相同则后者永远没有可提议的命中（被高优先级遮蔽）。
 */
export function compilePolicy(draft: PolicyDraft): Compilation {
  const diagnostics: CompileDiagnostic[] = [];
  const error = (
    code: CompileDiagnostic['code'],
    subjectId: string,
    message: string,
  ): void => {
    diagnostics.push({code, severity: 'error', subjectId, message});
  };
  const warning = (
    code: CompileDiagnostic['code'],
    subjectId: string,
    message: string,
  ): void => {
    diagnostics.push({code, severity: 'warning', subjectId, message});
  };

  const rules = draft.rules ?? [];
  const derived = draft.detectors ?? [];

  // ---- id 重复 / 缺失 ----
  const ruleIds = new Set<string>();
  for (const r of rules) {
    if (!r.id || !r.id.trim()) {
      error('duplicate_id', r.id ?? '', '规则 id 不能为空');
    } else if (ruleIds.has(r.id)) {
      error('duplicate_id', r.id, `规则 id "${r.id}" 重复`);
    } else {
      ruleIds.add(r.id);
    }
  }
  const derivedIds = new Set<string>();
  for (const d of derived) {
    if (!d.id || !d.id.trim()) {
      error('duplicate_id', d.id ?? '', '派生检测器 id 不能为空');
    } else if (BUILTIN_DETECTORS.some((b) => b.id === d.id)) {
      error('duplicate_id', d.id, `"${d.id}" 与内置检测器重名`);
    } else if (derivedIds.has(d.id)) {
      error('duplicate_id', d.id, `派生检测器 id "${d.id}" 重复`);
    } else {
      derivedIds.add(d.id);
    }
  }

  const knownDetectors = new Set<string>([
    ...BUILTIN_DETECTORS.map((b) => b.id),
    ...derivedIds,
  ]);

  // ---- 派生检测器引用解析 + 环检测 ----
  const badDerived = new Set<string>();
  const derivedMap = new Map(derived.filter((d) => d.id).map((d) => [d.id, d]));
  for (const d of derived) {
    if (!d.id) continue;
    const sources = d.sources ?? [];
    if (sources.length === 0) {
      error('invalid_reference', d.id, `派生检测器 "${d.id}" 没有任何来源`);
      badDerived.add(d.id);
      continue;
    }
    for (const source of sources) {
      if (!knownDetectors.has(source)) {
        error(
          'invalid_reference',
          d.id,
          `派生检测器 "${d.id}" 引用了不存在的检测器 "${source}"`,
        );
        badDerived.add(d.id);
      }
    }
    if (sources.includes(d.id)) {
      error('cycle_in_derivation', d.id, `派生检测器 "${d.id}" 直接引用自身`);
      badDerived.add(d.id);
    }
  }

  // 迭代式 DFS 找环，并把环上所有节点标坏；坏节点的下游传播标记
  const state = new Map<string, 0 | 1 | 2>(); // 0= visiting 1? 用 0/1/2: unvisited/visiting/done
  const cycleNodes = new Set<string>();
  const visit = (id: string, stack: string[]): void => {
    const s = state.get(id) ?? 2;
    if (s === 1) {
      const at = stack.indexOf(id);
      for (const node of stack.slice(at)) cycleNodes.add(node);
      return;
    }
    if (s === 2) return;
    state.set(id, 1);
    const node = derivedMap.get(id);
    for (const source of node?.sources ?? []) {
      if (derivedMap.has(source)) visit(source, [...stack, id]);
    }
    state.set(id, 2);
  };
  for (const id of derivedIds) {
    state.set(id, 0);
  }
  for (const id of derivedIds) visit(id, []);
  for (const id of cycleNodes) {
    error('cycle_in_derivation', id, `派生检测器 "${id}" 处于循环依赖链中：${[...cycleNodes].join(' → ')}`);
    badDerived.add(id);
  }
  // 下游传播：引用了坏节点的派生检测器同样不可用（不动点）
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of derived) {
      if (!d.id || badDerived.has(d.id)) continue;
      if ((d.sources ?? []).some((s) => badDerived.has(s))) {
        badDerived.add(d.id);
        grew = true;
      }
    }
  }

  /** 一个检测器最终由哪些“叶子”检测器产生（用于不可达判定的等价类） */
  const leafCache = new Map<string, Set<string>>();
  const leavesOf = (id: string): Set<string> => {
    const cached = leafCache.get(id);
    if (cached) return cached;
    const node = derivedMap.get(id);
    if (!node || badDerived.has(id)) {
      const set = new Set<string>(BUILTIN_DETECTORS.some((b) => b.id === id) ? [id] : []);
      leafCache.set(id, set);
      return set;
    }
    const set = new Set<string>();
    for (const source of node.sources) for (const leaf of leavesOf(source)) set.add(leaf);
    leafCache.set(id, set);
    return set;
  };

  // ---- 规则校验 ----
  const activeRules: ActiveRule[] = [];
  rules.forEach((rule, index) => {
    const subject = rule.id || `rule#${index + 1}`;
    if (!isFiniteNumber(rule.minConfidence) || rule.minConfidence < 0 || rule.minConfidence > 1) {
      error('invalid_threshold', subject, `规则 "${subject}" 的置信阈值必须在 0~1 之间`);
      return;
    }
    if (!STRATEGIES.includes(rule.strategy)) {
      error('invalid_reference', subject, `规则 "${subject}" 使用了未知替换策略 "${rule.strategy}"`);
      return;
    }
    if (!rule.detectorId || !knownDetectors.has(rule.detectorId)) {
      error('invalid_reference', subject, `规则 "${subject}" 引用了不存在的检测器 "${rule.detectorId ?? ''}"`);
      return;
    }
    if (badDerived.has(rule.detectorId)) {
      error(
        'cycle_in_derivation',
        subject,
        `规则 "${subject}" 依赖的检测器 "${rule.detectorId}" 处于无效派生链（成环或引用缺失）中`,
      );
      return;
    }
    if (!rule.enabled) return; // 停用的规则不参与模拟，也不参与遮蔽
    activeRules.push({...rule, priority: activeRules.length});
  });

  // ---- 永远不可达 ----
  // 同检测器闭包上存在更早（更高优先级）、阈值 <= 当前阈值的规则时，
  // 任何能通过当前阈值的命中必然也已被更早的规则提议，因此当前规则永不可达。
  for (let i = 0; i < activeRules.length; i++) {
    const current = activeRules[i];
    const currentLeaves = leavesOf(current.detectorId);
    for (let j = 0; j < i; j++) {
      const earlier = activeRules[j];
      const earlierLeaves = leavesOf(earlier.detectorId);
      const covers = [...currentLeaves].every((leaf) => earlierLeaves.has(leaf));
      if (covers && earlier.minConfidence <= current.minConfidence) {
        warning(
          'unreachable_rule',
          current.id,
          `规则 "${current.label || current.id}" 永远不可达：其命中范围被更高优先级规则 "${earlier.label || earlier.id}" 完全覆盖（更早且阈值 ${earlier.minConfidence} ≤ ${current.minConfidence}）`,
        );
        break;
      }
    }
  }

  const reachableDetectors = [...new Set(activeRules.map((r) => r.detectorId))];
  const canonical = canonicalize(draft);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);

  return {
    diagnostics,
    valid: diagnostics.every((d) => d.severity !== 'error'),
    activeRules,
    reachableDetectors,
    canonical,
    hash,
  };
}
