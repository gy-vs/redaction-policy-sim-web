// 策略编辑器 / 编译器 / 模拟器之间共享的领域类型。

/** 命中后的替换策略 */
export type ReplacementStrategy = 'mask' | 'label' | 'redact' | 'hash' | 'keep';

/** 规则：以检测器为输入，按列表顺序（即优先级）参与统一协调 */
export interface RuleDraft {
  id: string;
  detectorId: string;
  minConfidence: number; // 边界包含：confidence >= minConfidence 才提议
  strategy: ReplacementStrategy;
  label: string;
  enabled: boolean;
}

/** 派生检测器：由内置检测器或其他派生检测器组合而来 */
export interface DerivedDetector {
  id: string;
  label: string;
  sources: string[];
  combine: 'union' | 'intersect';
  /** intersect 时允许的最大间距（字符）；0 表示必须真正重叠 */
  window: number;
}

export interface PolicyDraft {
  name: string;
  detectors: DerivedDetector[];
  rules: RuleDraft[];
}

/** 服务端持久化的策略（带 revision 用于并发保存） */
export interface StoredPolicy extends PolicyDraft {
  revision: number;
  updatedAt: string;
}

export interface Finding {
  detectorId: string;
  start: number;
  end: number;
  confidence: number;
  value: string;
}

export interface DetectorFailure {
  detectorId: string;
  code: 'detector_unavailable' | 'detector_error';
  message: string;
}

export type DiagnosticCode =
  | 'invalid_reference' // 规则引用了不存在的检测器
  | 'invalid_threshold' // 阈值越界 / 非数字
  | 'duplicate_id' // 规则或派生检测器 id 重复 / 为空
  | 'cycle_in_derivation' // 派生图成环
  | 'unreachable_rule'; // 永远不可达：被同检测器更低阈值的靠前规则遮蔽

export interface CompileDiagnostic {
  code: DiagnosticCode;
  severity: 'error' | 'warning';
  subjectId: string;
  message: string;
}

export interface ActiveRule extends RuleDraft {
  /** 在最终规则序列中的位置，0 为最高优先级 */
  priority: number;
}

export interface Compilation {
  diagnostics: CompileDiagnostic[];
  valid: boolean;
  activeRules: ActiveRule[];
  reachableDetectors: string[];
  /** 规范化草稿，哈希由服务端注入 */
  canonical: string;
  hash?: string;
}

export interface ProposalPiece {
  start: number;
  end: number;
  status: 'applied' | 'overridden';
  byRuleId?: string;
  byRuleLabel?: string;
}

/** 一条规则针对一个命中提出的范围建议 */
export interface Proposal {
  key: string;
  ruleId: string;
  ruleLabel: string;
  detectorId: string;
  priority: number;
  start: number;
  end: number;
  confidence: number;
  threshold: number;
  strategy: ReplacementStrategy;
  value: string;
  status: 'applied' | 'partial' | 'overridden';
  /** 覆盖它的最高优先级规则 */
  overriddenByRuleId?: string;
  /** 所有与它争用字符的规则 */
  coveredByRuleIds: string[];
  pieces: ProposalPiece[];
  /** 人类可读的产生 / 覆盖原因 */
  reason: string;
}

/** 协调完成后最终生效的连续范围 */
export interface AppliedRange {
  start: number;
  end: number;
  ruleId: string;
  ruleLabel: string;
  detectorId: string;
  strategy: ReplacementStrategy;
  confidence: number;
  replacement: string;
}

export interface SampleStats {
  findings: number;
  proposals: number;
  applied: number;
  partial: number;
  overridden: number;
  ranges: number;
  detectorErrors: number;
  charsReplaced: number;
  byStrategy: Record<ReplacementStrategy, number>;
}

export interface SampleSimulation {
  sampleId: string;
  /** 实际处理时的样例 revision */
  sampleRevision: number;
  /** 任务开始时绑定的 revision；与 sampleRevision 不同说明中途被更新 */
  boundRevision: number;
  revisionChanged: boolean;
  policyHash: string;
  output: string;
  proposals: Proposal[];
  ranges: AppliedRange[];
  detectorErrors: DetectorFailure[];
  stats: SampleStats;
  /** 样例级致命错误（不影响其他样例） */
  error?: { code: string; message: string };
}

export interface SampleSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
}

export interface SampleRow extends SampleSummary {
  content: string;
}

/** 流式事件中的聚合统计 */
export interface BatchStats {
  phase: 'partial' | 'final';
  completed: number;
  total: number;
  ranges: number;
  applied: number;
  partial: number;
  overridden: number;
  detectorErrors: number;
  sampleErrors: number;
  charsReplaced: number;
  byStrategy: Record<ReplacementStrategy, number>;
}

export interface FinalBatchStats extends BatchStats {
  phase: 'final';
  cancelled: boolean;
  durationMs: number;
  policyHash: string;
  binding: { sampleId: string; revision: number }[];
}

export type SimEvent =
  | {
      type: 'start';
      jobId: string;
      policyHash: string;
      total: number;
      binding: { sampleId: string; revision: number }[];
    }
  | { type: 'progress'; stats: BatchStats; result: SampleSimulation }
  | { type: 'done'; stats: FinalBatchStats; results: SampleSimulation[]; policyHash: string }
  | { type: 'cancelled'; stats: FinalBatchStats; results: SampleSimulation[]; policyHash: string };
