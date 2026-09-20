// Shared domain model for the redaction policy workbench.
// Used by both the server (compile / simulate / save) and the client (typing).

export const DETECTOR_IDS = ['id-card', 'phone', 'email', 'bank-card'] as const;
export type DetectorId = (typeof DETECTOR_IDS)[number];

export const DETECTOR_LABELS: Record<DetectorId, string> = {
  'id-card': '身份证号',
  phone: '手机号',
  email: '邮箱地址',
  'bank-card': '银行卡号',
};

export type StrategyType = 'mask' | 'redact' | 'hash' | 'keep';

export const STRATEGY_LABELS: Record<StrategyType, string> = {
  mask: '掩码（保留首尾）',
  redact: '整体替换为固定文案',
  hash: '哈希占位',
  keep: '保留原文（仅标记）',
};

export interface Rule {
  id: string;
  name: string;
  detector: DetectorId;
  /** 命中置信度下限，区间 [0,1]，含边界 */
  threshold: number;
  strategy: StrategyType;
  /** 非空时该规则仅在 base 规则命中后才生效（派生规则） */
  base: string | null;
  /** 替换文案，strategy = redact 时必填 */
  replacement: string;
}

export interface Policy {
  /** 规则按数组顺序排列，索引越小优先级越高 */
  rules: Rule[];
}

export interface Sample {
  id: string;
  name: string;
  content: string;
  revision: number;
  updatedAt: string;
}

export interface PolicyRevision {
  revision: number;
  hash: string;
  policy: Policy;
  savedAt: string;
}

export interface Finding {
  detector: DetectorId;
  start: number;
  end: number;
  text: string;
  confidence: number;
}

export type CompileIssueCode =
  | 'invalid_reference'
  | 'circular_derivation'
  | 'unreachable_rule'
  | 'invalid_threshold'
  | 'missing_replacement';

export interface CompileIssue {
  code: CompileIssueCode;
  ruleId: string;
  message: string;
}

export interface CompiledRule extends Rule {
  order: number;
  chain: string[];
}

export interface CompiledPolicy {
  hash: string;
  rules: CompiledRule[];
  issues: CompileIssue[];
}

export interface RangeExplanation {
  ruleId: string;
  ruleName: string;
  order: number;
  detector: DetectorId;
  confidence: number;
  threshold: number;
  strategy: StrategyType;
  replacedWith: string;
}

export interface Decision {
  start: number;
  end: number;
  text: string;
  /** 最终生效的规则 */
  winner: RangeExplanation;
  /** 被更高优先级规则压制的候选 */
  overridden: RangeExplanation[];
}

export interface SampleResult {
  sampleId: string;
  sampleRevision: number;
  status: 'ok' | 'error';
  error?: string;
  /** 样例原文，前端用它把输出按决策坐标切成高亮片段 */
  input: string;
  decisions: Decision[];
  output: string;
  stats: {
    findings: number;
    winners: number;
    overridden: number;
    byRule: Record<string, number>;
  };
}

export interface SimulationSummary {
  policyHash: string;
  sampleRevision: number;
  samples: number;
  completed: number;
  failed: number;
  winners: number;
  overridden: number;
  /** 流式进行中为 true，终态事件里为 false */
  partial: boolean;
}

export type SimEvent =
  | {type: 'started'; policyHash: string; sampleRevision: number; total: number}
  | {type: 'sample'; result: SampleResult; summary: SimulationSummary}
  | {type: 'done'; summary: SimulationSummary; cancelled: boolean};

export interface SaveResult {
  ok: boolean;
  revision?: PolicyRevision;
  issues?: CompileIssue[];
  conflict?: {current: PolicyRevision};
}

export function isDetectorId(value: string): value is DetectorId {
  return (DETECTOR_IDS as readonly string[]).includes(value);
}
