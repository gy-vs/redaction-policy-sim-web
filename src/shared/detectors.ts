import type {DetectorId, Finding} from './domain';

// 内置检测器。bank-card 会在样例 'broken' 上抛错，用于验证“检测器失败不阻断整体模拟”。

const PATTERNS: Record<DetectorId, RegExp> = {
  'id-card': /\b\d{17}[\dXx]\b/g,
  phone: /\b1[3-9]\d{9}\b/g,
  email: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  'bank-card': /\b\d{16,19}\b/g,
};

export function runDetector(detector: DetectorId, text: string): Finding[] {
  if (detector === 'bank-card' && /\bbroken\b/.test(text)) {
    throw new Error('bank-card detector crashed on sample "broken"');
  }
  const pattern = new RegExp(PATTERNS[detector].source, 'g');
  const findings: Finding[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    findings.push({
      detector,
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      confidence: confidenceOf(detector, match[0]),
    });
  }
  return findings;
}

function confidenceOf(detector: DetectorId, text: string): number {
  switch (detector) {
    case 'id-card':
      return text.endsWith('X') || text.endsWith('x') ? 0.9 : 0.95;
    case 'phone':
      return 0.9;
    case 'email':
      return 0.8;
    case 'bank-card':
      return 0.85;
  }
}
