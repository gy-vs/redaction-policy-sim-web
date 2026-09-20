import type {DerivedDetector, Finding} from '../shared/types.js';

/**
 * 内置检测器：基于正则 + 固定置信度的“伪检测器”。
 * 真实系统里这些调用会走外部服务；这里保持纯函数且确定性。
 * confidence 与命中形态相关，用于演示阈值边界。
 */

interface PatternDef {
  re: RegExp;
  score: (text: string) => number;
}

const PATTERNS: Record<string, PatternDef> = {
  email: {
    // global + sticky 自行控制，保留 lastIndex 安全：每次新建正则
    re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
    score: (t) => (t.includes('@') && /\.[a-z]{2,}$/i.test(t) ? 0.95 : 0.7),
  },
  phone: {
    re: /(?:(?:\+?86[-\s]?)?1[3-9]\d{9})|(?:0\d{2,3}-?\d{7,8})/g,
    score: (t) => (t.startsWith('1') && t.length === 11 ? 0.92 : 0.74),
  },
  id_card: {
    re: /\b\d{17}[\dXx]\b/g,
    score: (t) => (/^\d{16}\dX$/i.test(t) ? 0.97 : 0.88),
  },
  bank_card: {
    re: /\b62\d{15,17}\b/g,
    score: () => 0.83,
  },
  name_cn: {
    // “张三/李四/王五”式，或 “某某某” 的 2~4 字中文
    re: /(?:姓名[:：]\s*)?[一-龥]{2,4}(?=先生|女士|同學|同学)?/g,
    score: (t) => (t.length === 2 ? 0.62 : 0.55),
  },
  address: {
    re: /[一-龥]{2,}(?:省|市|区|县|路|街|号|鎮|镇|村)\d*(?:号|弄|室)?/g,
    score: () => 0.68,
  },
  secret: {
    re: /(?:api[_-]?key|token|password|passwd|secret|密钥|口令)\s*[:=]\s*\S+/gi,
    score: () => 0.9,
  },
};

/** 测试可注入：让某个检测器在本次运行中失败（模拟超时 / 5xx） */
export type FailurePlan = Map<string, {code: 'detector_unavailable' | 'detector_error'; message: string}>;

export interface DetectOptions {
  failures?: FailurePlan;
  /** 每个检测器的人工延迟（毫秒），用于流式与取消的测试 */
  delayMs?: number;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        {once: true},
      );
    }
  });
}

/** 运行单个内置检测器 */
export async function runBuiltinDetector(
  detectorId: string,
  content: string,
  options: DetectOptions = {},
): Promise<Finding[]> {
  const planned = options.failures?.get(detectorId);
  if (planned) {
    // 失败也等待一点，模拟真实调用
    if (options.delayMs) await sleep(options.delayMs, options.signal);
    throw Object.assign(new Error(planned.message), {code: planned.code});
  }
  const def = PATTERNS[detectorId];
  if (!def) throw Object.assign(new Error(`unknown detector ${detectorId}`), {code: 'detector_error'});
  if (options.delayMs) await sleep(options.delayMs, options.signal);
  const findings: Finding[] = [];
  const re = new RegExp(def.re.source, def.re.flags);
  for (const match of content.matchAll(re)) {
    if (match.index === undefined) continue;
    const value = match[0];
    findings.push({
      detectorId,
      start: match.index,
      end: match.index + value.length,
      confidence: def.score(value),
      value,
    });
  }
  return findings;
}

/**
 * 展开派生检测器为叶子（内置）检测器集合，并按 combine 合并原始命中。
 * - union：所有来源命中直接保留（detectorId 改写为派生 id）
 * - intersect：保留 A 中与 B 某个命中间距 <= window 的命中（必须重叠/相邻才算交叉证据）
 * 循环 / 无效引用假定已在编译期排除；这里防御性返回空。
 */
export function evaluateDerived(
  derived: DerivedDetector,
  lookup: Map<string, Finding[]>,
): Finding[] {
  const sourceFindings = (derived.sources ?? [])
    .map((id) => lookup.get(id))
    .filter((v): v is Finding[] => Boolean(v));
  if (sourceFindings.length === 0) return [];

  if (derived.combine === 'union') {
    return sourceFindings.flat().map((f) => ({...f, detectorId: derived.id}));
  }

  // intersect：以第一个来源为基准，每个命中都要在其余来源中找到邻近命中
  const [base, ...rest] = sourceFindings;
  const window = Math.max(0, derived.window ?? 0);
  return base
    .filter((f) =>
      rest.every((list) =>
        list.some((g) => distanceBetween(f.start, f.end, g.start, g.end) <= window),
      ),
    )
    .map((f) => {
      // 置信度取交叉证据的最小值（更保守）
      const mates = rest.map((list) =>
        list
          .filter((g) => distanceBetween(f.start, f.end, g.start, g.end) <= window)
          .reduce((min, g) => Math.min(min, g.confidence), 1),
      );
      return {...f, detectorId: derived.id, confidence: Math.min(f.confidence, ...mates)};
    });
}

function distanceBetween(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  if (aEnd >= bStart && bEnd >= aStart) return 0; // 真正重叠
  return aEnd < bStart ? bStart - aEnd : aStart - bEnd;
}
