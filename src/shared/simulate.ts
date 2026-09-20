import type {
  CompiledPolicy,
  CompiledRule,
  Decision,
  Finding,
  RangeExplanation,
  SampleResult,
} from './domain';
import {runDetector} from './detectors';

interface Candidate {
  finding: Finding;
  rule: CompiledRule;
}

function overlaps(a: {start: number; end: number}, b: {start: number; end: number}): boolean {
  return a.start < b.end && b.start < a.end;
}

function explain(rule: CompiledRule, finding: Finding, replacedWith: string): RangeExplanation {
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    order: rule.order,
    detector: finding.detector,
    confidence: finding.confidence,
    threshold: rule.threshold,
    strategy: rule.strategy,
    replacedWith,
  };
}

export function applyStrategy(rule: CompiledRule, text: string): string {
  switch (rule.strategy) {
    case 'mask': {
      if (text.length <= 2) return '*'.repeat(text.length);
      const head = text.slice(0, Math.min(3, Math.ceil(text.length / 4)));
      const tail = text.slice(-Math.min(2, Math.floor(text.length / 4)));
      return `${head}${'*'.repeat(Math.max(3, text.length - head.length - tail.length))}${tail}`;
    }
    case 'redact':
      return rule.replacement;
    case 'hash':
      return `[hash:${rule.id}]`;
    case 'keep':
      return text;
  }
}

/**
 * 统一协调：所有检测器的候选命中进入同一个优先级队列。
 * 排序键：(start, order, -confidence, end) —— 完全确定，与检测器产出顺序无关。
 * 每个候选附带“被谁覆盖”与“覆盖了谁”的双向解释。
 */
export function coordinate(compiled: CompiledPolicy, findings: Finding[]): Decision[] {
  const candidates: Candidate[] = [];
  for (const rule of compiled.rules) {
    for (const finding of findings) {
      if (finding.detector !== rule.detector) continue;
      if (finding.confidence < rule.threshold) continue;
      if (rule.chain.length > 0) {
        // 派生规则：祖先链上的每条规则都必须有命中（任一置信度达标的范围）
        const satisfied = rule.chain.every(ancestorId => {
          const ancestor = compiled.rules.find(r => r.id === ancestorId);
          if (!ancestor) return false;
          return findings.some(
            f => f.detector === ancestor.detector && f.confidence >= ancestor.threshold,
          );
        });
        if (!satisfied) continue;
      }
      candidates.push({finding, rule});
    }
  }

  candidates.sort((a, b) => {
    if (a.finding.start !== b.finding.start) return a.finding.start - b.finding.start;
    if (a.rule.order !== b.rule.order) return a.rule.order - b.rule.order;
    if (a.finding.confidence !== b.finding.confidence) return b.finding.confidence - a.finding.confidence;
    return a.finding.end - b.finding.end;
  });

  const decisions: Decision[] = [];
  for (const candidate of candidates) {
    const winner = decisions.find(d => overlaps(d, candidate.finding));
    const replacedWith = applyStrategy(candidate.rule, candidate.finding.text);
    const explanation = explain(candidate.rule, candidate.finding, replacedWith);
    if (!winner) {
      decisions.push({
        start: candidate.finding.start,
        end: candidate.finding.end,
        text: candidate.finding.text,
        winner: explanation,
        overridden: [],
      });
    } else {
      winner.overridden.push(explanation);
    }
  }
  return decisions;
}

/** 按决策从后往前替换，生成脱敏后的文本。 */
export function applyDecisions(text: string, decisions: Decision[]): string {
  const ordered = [...decisions].sort((a, b) => b.start - a.start);
  let output = text;
  for (const decision of ordered) {
    output = output.slice(0, decision.start) + decision.winner.replacedWith + output.slice(decision.end);
  }
  return output;
}

export function simulateSample(
  compiled: CompiledPolicy,
  sample: {id: string; revision: number; content: string},
): SampleResult {
  const findings: Finding[] = [];
  const detectors = [...new Set(compiled.rules.map(rule => rule.detector))];
  for (const detector of detectors) {
    findings.push(...runDetector(detector, sample.content));
  }
  const decisions = coordinate(compiled, findings);
  const byRule: Record<string, number> = {};
  let overridden = 0;
  for (const decision of decisions) {
    byRule[decision.winner.ruleId] = (byRule[decision.winner.ruleId] ?? 0) + 1;
    overridden += decision.overridden.length;
  }
  return {
    sampleId: sample.id,
    sampleRevision: sample.revision,
    status: 'ok',
    input: sample.content,
    decisions,
    output: applyDecisions(sample.content, decisions),
    stats: {
      findings: findings.length,
      winners: decisions.length,
      overridden,
      byRule,
    },
  };
}
