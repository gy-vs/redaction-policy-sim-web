import type {
  BatchStats,
  Compilation,
  DetectorFailure,
  Finding,
  PolicyDraft,
  ReplacementStrategy,
  SampleRow,
  SampleSimulation,
} from '../shared/types.js';
import {coordinate} from './coordinator.js';
import {
  evaluateDerived,
  runBuiltinDetector,
  type DetectOptions,
} from './detectorEngine.js';
import {BUILTIN_DETECTORS} from './policyCompiler.js';

/** 模拟任务选项：失败注入、延迟、取消信号 */
export interface SimulateOptions extends DetectOptions {
  /** 仅模拟这些样例（默认全部） */
  sampleIds?: string[];
  /** 每个样例开始前回调，用于流式推送 */
  onResult?: (result: SampleSimulation, index: number, total: number) => Promise<void> | void;
}

/** 找出闭包内所有需要运行的叶子检测器（含派生检测器的来源） */
export function requiredLeafDetectors(compilation: Compilation, draft: PolicyDraft): string[] {
  const derivedMap = new Map(draft.detectors.map((d) => [d.id, d]));
  const leaves = new Set<string>();
  const walk = (id: string): void => {
    const node = derivedMap.get(id);
    if (!node) {
      if (BUILTIN_DETECTORS.some((b) => b.id === id)) leaves.add(id);
      return;
    }
    for (const source of node.sources) walk(source);
  };
  for (const rule of compilation.activeRules) walk(rule.detectorId);
  return [...leaves].sort();
}

/**
 * 对一组样例批量模拟。
 * - policyHash 在任务开始时绑定（来自编译哈希）；
 * - 每个样例单独 try/catch：错误样例不阻断其他样例；
 * - AbortSignal 触发后不再开始新样例，已完成结果保留并标记 cancelled。
 */
export async function simulateBatch(
  draft: PolicyDraft,
  compilation: Compilation,
  samples: SampleRow[],
  options: SimulateOptions = {},
): Promise<{results: SampleSimulation[]; cancelled: boolean; total: number}> {
  const targets = options.sampleIds?.length
    ? samples.filter((s) => options.sampleIds!.includes(s.id))
    : samples;
  const total = targets.length;
  const leafIds = requiredLeafDetectors(compilation, draft);
  const results: SampleSimulation[] = [];
  let cancelled = false;

  for (let index = 0; index < targets.length; index++) {
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }
    const sample = targets[index];
    const boundRevision = sample.revision;
    const result = await simulateOne(draft, compilation, sample, leafIds, boundRevision, options);
    results.push(result);
    await options.onResult?.(result, index, total);
  }
  if (options.signal?.aborted && !cancelled) cancelled = true;
  return {results, cancelled, total};
}

async function simulateOne(
  draft: PolicyDraft,
  compilation: Compilation,
  sample: SampleRow,
  leafIds: string[],
  boundRevision: number,
  options: SimulateOptions,
): Promise<SampleSimulation> {
  const detectorErrors: DetectorFailure[] = [];
  try {
    // 1) 运行叶子检测器：单个失败记录为检测器错误，不抛出
    const leafFindings = new Map<string, Finding[]>();
    await Promise.all(
      leafIds.map(async (id) => {
        try {
          leafFindings.set(id, await runBuiltinDetector(id, sample.content, options));
        } catch (error) {
          if ((error as Error).name === 'AbortError') throw error;
          const code =
            (error as {code?: DetectorFailure['code']}).code ?? 'detector_error';
          detectorErrors.push({
            detectorId: id,
            code: code === 'detector_unavailable' ? 'detector_unavailable' : 'detector_error',
            message: (error as Error).message || '检测器执行失败',
          });
          leafFindings.set(id, []);
        }
      }),
    );
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // 2) 按依赖顺序求派生检测器（失败/成环已在编译期排除）
    const lookup = new Map<string, Finding[]>(leafFindings);
    const resolved = new Set<string>(leafIds);
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const derived of draft.detectors) {
        if (resolved.has(derived.id)) continue;
        if (derived.sources.every((s) => resolved.has(s))) {
          lookup.set(derived.id, evaluateDerived(derived, lookup));
          resolved.add(derived.id);
          progressed = true;
        }
      }
    }

    // 3) 统一协调
    const {proposals, ranges, output, stats} = coordinate(
      sample.content,
      compilation.activeRules,
      lookup,
      detectorErrors,
    );

    return {
      sampleId: sample.id,
      sampleRevision: sample.revision,
      boundRevision,
      revisionChanged: sample.revision !== boundRevision,
      policyHash: compilation.hash ?? '',
      output,
      proposals,
      ranges,
      detectorErrors,
      stats,
    };
  } catch (error) {
    // 样例级致命错误（含取消）：封装为结果，不影响其他样例
    return {
      sampleId: sample.id,
      sampleRevision: sample.revision,
      boundRevision,
      revisionChanged: sample.revision !== boundRevision,
      policyHash: compilation.hash ?? '',
      output: sample.content,
      proposals: [],
      ranges: [],
      detectorErrors,
      stats: {
        findings: 0,
        proposals: 0,
        applied: 0,
        partial: 0,
        overridden: 0,
        ranges: 0,
        detectorErrors: detectorErrors.length,
        charsReplaced: 0,
        byStrategy: {mask: 0, label: 0, redact: 0, hash: 0, keep: 0},
      },
      error: {
        code: (error as Error).name === 'AbortError' ? 'aborted' : 'simulation_failed',
        message: (error as Error).message || '模拟失败',
      },
    };
  }
}

export function aggregateStats(
  results: SampleSimulation[],
  total: number,
  phase: 'partial' | 'final',
): BatchStats {
  const byStrategy: Record<ReplacementStrategy, number> = {
    mask: 0,
    label: 0,
    redact: 0,
    hash: 0,
    keep: 0,
  };
  let ranges = 0;
  let applied = 0;
  let partial = 0;
  let overridden = 0;
  let detectorErrors = 0;
  let sampleErrors = 0;
  let charsReplaced = 0;
  for (const r of results) {
    ranges += r.stats.ranges;
    applied += r.stats.applied;
    partial += r.stats.partial;
    overridden += r.stats.overridden;
    detectorErrors += r.detectorErrors.length;
    // 取消中断的样例不计入样例错误
    if (r.error && r.error.code !== 'aborted') sampleErrors += 1;
    charsReplaced += r.stats.charsReplaced;
    for (const key of Object.keys(byStrategy) as ReplacementStrategy[]) {
      byStrategy[key] += r.stats.byStrategy[key];
    }
  }
  return {
    phase,
    completed: results.length,
    total,
    ranges,
    applied,
    partial,
    overridden,
    detectorErrors,
    sampleErrors,
    charsReplaced,
    byStrategy,
  };
}
