import {createHash} from 'node:crypto';
import type {
  ActiveRule,
  AppliedRange,
  DetectorFailure,
  Finding,
  Proposal,
  ProposalPiece,
  ReplacementStrategy,
  SampleStats,
} from '../shared/types.js';

interface PieceMeta {
  ruleId: string;
  ruleLabel: string;
  detectorId: string;
  strategy: ReplacementStrategy;
  confidence: number;
  value: string;
}

interface AppliedPiece extends ProposalPiece {
  meta: PieceMeta;
}

function emptyStats(detectorErrors: DetectorFailure[]): SampleStats {
  return {
    findings: 0,
    proposals: 0,
    applied: 0,
    partial: 0,
    overridden: 0,
    ranges: 0,
    detectorErrors: detectorErrors.length,
    charsReplaced: 0,
    byStrategy: {mask: 0, label: 0, redact: 0, hash: 0, keep: 0},
  };
}

function renderReplacement(strategy: ReplacementStrategy, value: string, label: string): string {
  switch (strategy) {
    case 'mask':
      return '***';
    case 'label':
      return `[${label || 'REDACTED'}]`;
    case 'redact':
      return '█'.repeat(value.length);
    case 'hash':
      return createHash('sha1').update(value).digest('hex').slice(0, 8);
    case 'keep':
      return value;
  }
}

/**
 * 统一协调：按规则优先级（数组顺序）逐条提交建议，字符只能被一条规则占用。
 * 边界约定：半开区间 [start, end)；阈值边界包含（confidence >= min 即可提议）。
 */
export function coordinate(
  content: string,
  rules: ActiveRule[],
  findingsByDetector: Map<string, Finding[]>,
  detectorErrors: DetectorFailure[] = [],
): {proposals: Proposal[]; ranges: AppliedRange[]; output: string; stats: SampleStats} {
  const stats = emptyStats(detectorErrors);
  const proposals: Proposal[] = [];
  /** 已占用字符 -> 占用它的规则；长度即字符数，确定性的逐字符归属 */
  const owner = new Int32Array(content.length).fill(-1);
  const appliedPieces: AppliedPiece[] = [];
  const countedDetectors = new Set<string>();

  for (const rule of rules) {
    const findings = findingsByDetector.get(rule.detectorId) ?? [];
    if (!countedDetectors.has(rule.detectorId)) {
      stats.findings += findings.length;
      countedDetectors.add(rule.detectorId);
    }
    // 同规则的命中按起点排序，保证重叠时的先后确定
    const ordered = [...findings].sort((a, b) => a.start - b.start || a.end - b.end);
    for (const finding of ordered) {
      if (finding.confidence < rule.minConfidence) continue; // 边界包含：恰好相等会通过
      stats.proposals += 1;

      // 收集与本提议争用字符的更高优先级规则（同规则更早提交的重叠命中不算覆盖）
      const covering = new Map<number, number>(); // rulePriority -> 覆盖字符数
      const sameRuleChars = {value: 0};
      for (let i = finding.start; i < finding.end && i < content.length; i++) {
        const ownerPriority = owner[i];
        if (ownerPriority === -1) continue;
        if (ownerPriority === rule.priority) {
          sameRuleChars.value += 1;
        } else {
          covering.set(ownerPriority, (covering.get(ownerPriority) ?? 0) + 1);
        }
      }
      const coveredPriorities = [...covering.keys()].sort((a, b) => a - b);
      const coveringRules = rulesByPriority(rules, coveredPriorities);
      const key = `${rule.id}@${finding.start}:${finding.end}`;
      const meta: PieceMeta = {
        ruleId: rule.id,
        ruleLabel: rule.label,
        detectorId: rule.detectorId,
        strategy: rule.strategy,
        confidence: finding.confidence,
        value: finding.value,
      };

      let status: Proposal['status'];
      let reason: string;
      let pieces: ProposalPiece[] = [];
      const base = `规则 P${rule.priority}「${rule.label || rule.id}」由检测器 ${rule.detectorId} 产生：命中“${finding.value}”（置信度 ${finding.confidence} ≥ 阈值 ${rule.minConfidence}），范围 [${finding.start}, ${finding.end})`;

      if (coveringRules.length === 0 && sameRuleChars.value === 0) {
        status = 'applied';
        reason = `${base}；该范围没有更高优先级提议，整条生效。`;
        pieces = [{start: finding.start, end: finding.end, status: 'applied'}];
      } else {
        // 切成片段：空闲片段生效，已占用片段标注由谁覆盖
        const segments: ProposalPiece[] = [];
        let cursor = finding.start;
        while (cursor < finding.end) {
          const ownerPriority = owner[cursor];
          const nextEnd = findOwnerBoundary(owner, cursor, finding.end, ownerPriority);
          if (ownerPriority === -1) {
            segments.push({start: cursor, end: nextEnd, status: 'applied'});
          } else if (ownerPriority === rule.priority) {
            // 同规则更早提交的命中已占用，静默并入，不算覆盖
            segments.push({
              start: cursor,
              end: nextEnd,
              status: 'overridden',
              byRuleId: rule.id,
              byRuleLabel: `${rule.label || rule.id}（同规则更早的命中）`,
            });
          } else {
            const by = rules[ownerPriority];
            segments.push({
              start: cursor,
              end: nextEnd,
              status: 'overridden',
              byRuleId: by.id,
              byRuleLabel: by.label || by.id,
            });
          }
          cursor = nextEnd;
        }
        pieces = segments;
        const freeChars = segments
          .filter((s) => s.status === 'applied')
          .reduce((sum, s) => sum + (s.end - s.start), 0);
        const coverList = coveringRules.map((r) => `P${r.priority}「${r.label || r.id}」`).join('、');
        const detail = segments
          .map((s) =>
            s.status === 'applied'
              ? `[${s.start}, ${s.end}) 生效`
              : `[${s.start}, ${s.end}) 被 ${s.byRuleLabel} 覆盖`,
          )
          .join('；');
        if (freeChars === 0 && coveringRules.length > 0) {
          status = 'overridden';
          reason = `${base}；但整段已被更高优先级规则 ${coverList} 占用，本提议不产生任何替换（${detail}）。`;
        } else if (coveringRules.length > 0) {
          status = 'partial';
          reason = `${base}；与更高优先级规则 ${coverList} 重叠：${detail}，仅空闲片段生效。`;
        } else {
          status = 'applied';
          reason = `${base}；未被更高优先级规则覆盖，空闲片段生效（与同规则更早命中重叠处自动并入）。`;
        }
      }

      proposals.push({
        key,
        ruleId: rule.id,
        ruleLabel: rule.label || rule.id,
        detectorId: rule.detectorId,
        priority: rule.priority,
        start: finding.start,
        end: finding.end,
        confidence: finding.confidence,
        threshold: rule.minConfidence,
        strategy: rule.strategy,
        value: finding.value,
        status,
        overriddenByRuleId: coveringRules[0]?.id,
        coveredByRuleIds: coveringRules.map((r) => r.id),
        pieces,
        reason,
      });
      stats[status] += 1;

      // 仅生效片段占用字符并记录
      for (const piece of pieces) {
        if (piece.status !== 'applied') continue;
        for (let i = piece.start; i < piece.end; i++) owner[i] = rule.priority;
        appliedPieces.push({...piece, meta});
      }
    }
  }

  // 合并相邻且同规则的生效片段，形成最终连续范围
  appliedPieces.sort((a, b) => a.start - b.start);
  const ranges: AppliedRange[] = [];
  for (const piece of appliedPieces) {
    const last = ranges[ranges.length - 1];
    if (
      last &&
      last.end === piece.start &&
      last.ruleId === piece.meta.ruleId &&
      last.strategy === piece.meta.strategy
    ) {
      last.end = piece.end;
      last.confidence = Math.max(last.confidence, piece.meta.confidence);
      last.replacement = renderForRange(last, content);
    } else {
      const range: AppliedRange = {
        start: piece.start,
        end: piece.end,
        ruleId: piece.meta.ruleId,
        ruleLabel: piece.meta.ruleLabel,
        detectorId: piece.meta.detectorId,
        strategy: piece.meta.strategy,
        confidence: piece.meta.confidence,
        replacement: '',
      };
      range.replacement = renderReplacement(
        range.strategy,
        content.slice(range.start, range.end),
        range.ruleLabel,
      );
      ranges.push(range);
    }
  }

  // 生成替换后文本
  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    output += content.slice(cursor, range.start);
    output += range.replacement;
    cursor = range.end;
    if (range.strategy !== 'keep') stats.charsReplaced += range.end - range.start;
    stats.byStrategy[range.strategy] += 1;
  }
  output += content.slice(cursor);
  stats.ranges = ranges.length;

  return {proposals, ranges, output, stats};
}

function rulesByPriority(rules: ActiveRule[], priorities: number[]): ActiveRule[] {
  return priorities.map((p) => rules[p]).filter(Boolean);
}

function findOwnerBoundary(
  owner: Int32Array,
  start: number,
  end: number,
  ownerPriority: number,
): number {
  let i = start;
  while (i < end && owner[i] === ownerPriority) i++;
  return i;
}

function renderForRange(range: AppliedRange, content: string): string {
  return renderReplacement(range.strategy, content.slice(range.start, range.end), range.ruleLabel);
}
