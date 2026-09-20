import type {Decision, SampleResult} from '../../shared/domain';
import {DETECTOR_LABELS, STRATEGY_LABELS} from '../../shared/domain';

/**
 * 按原文坐标把输出切成「原文间隙 / 替换片段」交替序列。
 * 替换片段高亮，title 给出生成它的规则；被覆盖候选在下方列表解释。
 */
function HighlightedOutput({result}: {result: SampleResult}) {
  const decisions = [...result.decisions].sort((a, b) => a.start - b.start);
  const nodes: Array<{key: number; text: string; decision?: Decision}> = [];
  let cursor = 0;
  decisions.forEach((decision, index) => {
    if (decision.start > cursor) {
      nodes.push({key: index * 2, text: result.input.slice(cursor, decision.start)});
    }
    nodes.push({key: index * 2 + 1, text: decision.winner.replacedWith, decision});
    cursor = decision.end;
  });
  if (cursor < result.input.length) {
    nodes.push({key: -1, text: result.input.slice(cursor)});
  }
  return (
    <div className="output-text" data-testid="output-text">
      {nodes.map(node =>
        node.decision ? (
          <mark
            key={node.key}
            className="hit"
            title={`由规则 ${node.decision.winner.ruleName}（优先级 #${node.decision.winner.order + 1}）生成`}
          >
            {node.text}
          </mark>
        ) : (
          <span key={node.key}>{node.text}</span>
        ),
      )}
    </div>
  );
}

export function SampleResultView({result}: {result: SampleResult}) {
  if (result.status === 'error') {
    return (
      <div className="sample-result error" role="alert">
        <strong>样例失败：</strong>
        {result.error}
        <span className="muted">（该错误不阻断其他样例）</span>
      </div>
    );
  }
  return (
    <div className="sample-result">
      <HighlightedOutput result={result} />
      {result.decisions.length === 0 && <p className="muted">无命中范围</p>}
      <ul className="decision-list">
        {result.decisions.map((decision, i) => (
          <li key={i}>
            <div className="decision-winner">
              <span className="range">
                [{decision.start},{decision.end}) “{decision.text}”
              </span>
              → 由规则 <strong>{decision.winner.ruleName}</strong>（优先级 #
              {decision.winner.order + 1}，检测器 {DETECTOR_LABELS[decision.winner.detector]}
              ，置信度 {decision.winner.confidence.toFixed(2)} ≥ 阈值{' '}
              {decision.winner.threshold.toFixed(2)}，策略{' '}
              {STRATEGY_LABELS[decision.winner.strategy]}）替换为 “
              {decision.winner.replacedWith}”
            </div>
            {decision.overridden.map((candidate, j) => (
              <div className="decision-overridden" key={j}>
                ⤷ 被覆盖：规则 <strong>{candidate.ruleName}</strong>（优先级 #
                {candidate.order + 1}，置信度 {candidate.confidence.toFixed(2)}）也命中范围 [
                {decision.start},{decision.end})，但规则 “{decision.winner.ruleName}” 优先级 #
                {decision.winner.order + 1} 更高，故被压制
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
