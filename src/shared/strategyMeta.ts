import type {ReplacementStrategy} from './types';

export const STRATEGIES: ReplacementStrategy[] = ['mask', 'label', 'redact', 'hash', 'keep'];

export const STRATEGY_LABEL: Record<ReplacementStrategy, string> = {
  mask: '掩码 ***',
  label: '标签',
  redact: '涂黑',
  hash: '哈希摘要',
  keep: '保留原文',
};
