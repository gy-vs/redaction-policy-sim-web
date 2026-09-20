import {describe, expect, it} from 'vitest';
import {compilePolicy, BUILTIN_DETECTORS} from '../src/server/policyCompiler';
import {coordinate} from '../src/server/coordinator';
import type {ActiveRule, PolicyDraft, RuleDraft} from '../src/shared/types';

function rule(partial: Partial<RuleDraft> & {id: string; detectorId: string}): RuleDraft {
  return {
    minConfidence: 0,
    strategy: 'mask',
    label: partial.id,
    enabled: true,
    ...partial,
  };
}

function draft(rules: RuleDraft[], detectors: PolicyDraft['detectors'] = []): PolicyDraft {
  return {name: 't', detectors, rules};
}

describe('policyCompiler', () => {
  it('检测无效引用：规则指向不存在的检测器', () => {
    const result = compilePolicy(draft([rule({id: 'r1', detectorId: 'ghost'})]));
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'invalid_reference' && d.subjectId === 'r1')).toBe(true);
  });

  it('检测循环派生：A→B→A 成环，引用环的规则无法参与模拟', () => {
    const d: PolicyDraft['detectors'] = [
      {id: 'a', label: 'A', sources: ['b'], combine: 'union', window: 0},
      {id: 'b', label: 'B', sources: ['a'], combine: 'union', window: 0},
    ];
    const result = compilePolicy(draft([rule({id: 'r1', detectorId: 'a'})], d));
    expect(result.valid).toBe(false);
    expect(result.diagnostics.filter((x) => x.code === 'cycle_in_derivation').length).toBeGreaterThan(0);
    expect(result.activeRules).toHaveLength(0);
  });

  it('检测自引用与无效来源的下游传播', () => {
    const d: PolicyDraft['detectors'] = [
      {id: 'self', label: 's', sources: ['self'], combine: 'union', window: 0},
      {id: 'down', label: 'd', sources: ['self', 'email'], combine: 'union', window: 0},
    ];
    const result = compilePolicy(draft([rule({id: 'r1', detectorId: 'down'})], d));
    expect(result.diagnostics.some((x) => x.code === 'cycle_in_derivation' && x.subjectId === 'self')).toBe(true);
    // down 引用坏节点 → 规则被拒
    expect(result.valid).toBe(false);
    expect(result.activeRules).toHaveLength(0);
  });

  it('检测阈值越界（负数 / 大于 1 / NaN）', () => {
    const r1 = compilePolicy(draft([rule({id: 'r1', detectorId: 'email', minConfidence: -0.1})]));
    const r2 = compilePolicy(draft([rule({id: 'r2', detectorId: 'email', minConfidence: 1.1})]));
    const r3 = compilePolicy(draft([rule({id: 'r3', detectorId: 'email', minConfidence: NaN})]));
    for (const r of [r1, r2, r3]) {
      expect(r.valid).toBe(false);
      expect(r.diagnostics.some((d) => d.code === 'invalid_threshold')).toBe(true);
    }
  });

  it('检测 id 重复', () => {
    const result = compilePolicy(
      draft([rule({id: 'dup', detectorId: 'email'}), rule({id: 'dup', detectorId: 'phone'})]),
    );
    expect(result.diagnostics.some((d) => d.code === 'duplicate_id')).toBe(true);
  });

  it('永远不可达：同检测器上更早且阈值更低的规则遮蔽后者', () => {
    const result = compilePolicy(
      draft([
        rule({id: 'low', detectorId: 'email', minConfidence: 0.5, label: '低阈值'}),
        rule({id: 'high', detectorId: 'email', minConfidence: 0.9, label: '高阈值'}),
      ]),
    );
    const unreachable = result.diagnostics.find((d) => d.code === 'unreachable_rule');
    expect(unreachable?.subjectId).toBe('high');
    // 不可达是警告，不阻断保存
    expect(result.valid).toBe(true);
  });

  it('阈值相等时后规则仍不可达（边界包含），但阈值更低的后规则可达', () => {
    const equal = compilePolicy(
      draft([
        rule({id: 'a', detectorId: 'email', minConfidence: 0.8}),
        rule({id: 'b', detectorId: 'email', minConfidence: 0.8}),
      ]),
    );
    expect(equal.diagnostics.some((d) => d.code === 'unreachable_rule' && d.subjectId === 'b')).toBe(true);

    const lower = compilePolicy(
      draft([
        rule({id: 'a', detectorId: 'email', minConfidence: 0.8}),
        rule({id: 'b', detectorId: 'email', minConfidence: 0.6}),
      ]),
    );
    expect(lower.diagnostics.some((d) => d.code === 'unreachable_rule')).toBe(false);
  });

  it('规则重排改变优先级顺序与哈希', () => {
    const base = draft([
      rule({id: 'a', detectorId: 'email', minConfidence: 0.9}),
      rule({id: 'b', detectorId: 'phone', minConfidence: 0.9}),
    ]);
    const reordered = draft([...base.rules].reverse());
    expect(compilePolicy(base).hash).not.toBe(compilePolicy(reordered).hash);
    const c = compilePolicy(reordered);
    expect(c.activeRules[0].id).toBe('b');
    expect(c.activeRules[0].priority).toBe(0);
  });

  it('停用规则不参与模拟也不遮蔽后续规则', () => {
    const result = compilePolicy(
      draft([
        rule({id: 'off', detectorId: 'email', minConfidence: 0, enabled: false}),
        rule({id: 'on', detectorId: 'email', minConfidence: 0.9}),
      ]),
    );
    expect(result.activeRules.map((r) => r.id)).toEqual(['on']);
    expect(result.diagnostics.some((d) => d.code === 'unreachable_rule')).toBe(false);
  });

  it('内置检测器清单稳定', () => {
    expect(BUILTIN_DETECTORS.map((d) => d.id).sort()).toEqual(
      expect.arrayContaining(['email', 'phone', 'id_card', 'bank_card']),
    );
  });
});

describe('coordinator', () => {
  function active(id: string, priority: number, strategy: ActiveRule['strategy'] = 'mask', minConfidence = 0, label = id): ActiveRule {
    return {id, detectorId: id, minConfidence, strategy, label, enabled: true, priority};
  }

  it('阈值边界包含：confidence 恰好等于阈值时提议生效', () => {
    const {ranges} = coordinate(
      'x@y.zz',
      [active('email', 0, 'mask', 0.95)],
      new Map([['email', [{detectorId: 'email', start: 0, end: 6, confidence: 0.95, value: 'x@y.zz'}]]]),
    );
    expect(ranges).toHaveLength(1);
  });

  it('阈值边界外：低于阈值不提议', () => {
    const {ranges, proposals} = coordinate(
      'x@y.zz',
      [active('email', 0, 'mask', 0.96)],
      new Map([['email', [{detectorId: 'email', start: 0, end: 6, confidence: 0.95, value: 'x@y.zz'}]]]),
    );
    expect(ranges).toHaveLength(0);
    expect(proposals).toHaveLength(0);
  });

  it('重叠范围按确定优先级协调：高优先级覆盖低优先级，并给出 reason', () => {
    const {ranges, proposals, output} = coordinate(
      'abc@example.com!!',
      [active('secret', 0, 'redact'), active('email', 1, 'mask')],
      new Map([
        ['secret', [{detectorId: 'secret', start: 0, end: 13, confidence: 0.99, value: 'abc@example.c'}]],
        ['email', [{detectorId: 'email', start: 0, end: 15, confidence: 0.95, value: 'abc@example.com'}]],
      ]),
    );
    expect(ranges).toHaveLength(2);
    // [0,13) 属于 secret；email 只拿到 [13,15)
    expect(ranges[0].ruleId).toBe('secret');
    expect(ranges[1].ruleId).toBe('email');
    expect(ranges[1].start).toBe(13);
    const emailProposal = proposals.find((p) => p.ruleId === 'email');
    expect(emailProposal?.status).toBe('partial');
    expect(emailProposal?.overriddenByRuleId).toBe('secret');
    expect(emailProposal?.reason).toContain('secret');
    expect(output).toContain('█');
  });

  it('完全被覆盖的提议标记 overridden 且不产生范围', () => {
    const {ranges, proposals} = coordinate(
      '13800000000',
      [active('phone', 0), active('id_card', 1)],
      new Map([
        ['phone', [{detectorId: 'phone', start: 0, end: 11, confidence: 0.9, value: '13800000000'}]],
        ['id_card', [{detectorId: 'id_card', start: 0, end: 11, confidence: 0.85, value: '13800000000'}]],
      ]),
    );
    expect(ranges.map((r) => r.ruleId)).toEqual(['phone']);
    expect(proposals.find((p) => p.ruleId === 'id_card')?.status).toBe('overridden');
  });

  it('替换策略产出确定：mask/label/redact/hash/keep', () => {
    const text = 'aaaaabbbbbccccc';
    const rules = ([
      ['a', 0, 'mask'],
      ['b', 1, 'label'],
      ['c', 2, 'redact'],
    ] as const).map(([id, p, s]) => active(id, p, s, 0, id.toUpperCase()));
    const findings = new Map([
      ['a', [{detectorId: 'a', start: 0, end: 5, confidence: 1, value: 'aaaaa'}]],
      ['b', [{detectorId: 'b', start: 5, end: 10, confidence: 1, value: 'bbbbb'}]],
      ['c', [{detectorId: 'c', start: 10, end: 15, confidence: 1, value: 'ccccc'}]],
    ]);
    const {output, ranges} = coordinate(text, rules, findings);
    expect(ranges[0].replacement).toBe('***');
    expect(ranges[1].replacement).toBe('[B]');
    expect(ranges[2].replacement).toBe('█████');
    expect(output).toBe('***[B]█████');
  });

  it('hash 策略对相同值给出相同摘要且不泄露原文', () => {
    const {ranges} = coordinate(
      'secret-value',
      [active('s', 0, 'hash')],
      new Map([['s', [{detectorId: 's', start: 0, end: 12, confidence: 1, value: 'secret-value'}]]]),
    );
    expect(ranges[0].replacement).toMatch(/^[0-9a-f]{8}$/);
    expect(ranges[0].replacement).not.toContain('secret');
  });

  it('同规则相邻片段合并为单个范围', () => {
    const {ranges} = coordinate(
      'ab',
      [active('d', 0)],
      new Map([
        ['d', [
          {detectorId: 'd', start: 0, end: 1, confidence: 1, value: 'a'},
          {detectorId: 'd', start: 1, end: 2, confidence: 1, value: 'b'},
        ]],
      ]),
    );
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({start: 0, end: 2});
  });
});
