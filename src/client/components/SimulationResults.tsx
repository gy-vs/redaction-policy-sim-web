import type {
  BatchStats,
  FinalBatchStats,
  SampleSimulation,
  SampleSummary,
} from '../../shared/types';
import {STRATEGY_LABEL} from '../../shared/strategyMeta';

interface Props {
  samples: SampleSummary[];
  results: SampleSimulation[]; // 已完成样例的流式结果
  running: boolean;
  cancelled: boolean;
  partial: BatchStats | null;
  finalStats: FinalBatchStats | null;
  stale: boolean;
  selectedSampleId: string | null;
  onSelectSample: (id: string) => void;
}

const STATUS_LABEL: Record<SampleSimulation['proposals'][number]['status'], string> = {
  applied: '整条生效',
  partial: '部分生效',
  overridden: '被覆盖',
};

export function SimulationResults({
  samples,
  results,
  running,
  cancelled,
  partial,
  finalStats,
  stale,
  selectedSampleId,
  onSelectSample,
}: Props) {
  const byId = new Map(results.map((r) => [r.sampleId, r]));
  const current = selectedSampleId ? byId.get(selectedSampleId) : results[0];

  return (
    <div className="sim-results">
      <div className="sim-statusbar">
        {stale && (
          <span className="badge stale" title="策略或样例已修改，下面的结果来自上一次模拟">
            ⚠ 结果已过期（保留用于对照）
          </span>
        )}
        {running && <span className="badge running">模拟进行中…</span>}
        {cancelled && !running && <span className="badge cancelled">已取消（保留已完成样例）</span>}
        {finalStats && !running && (
          <span className="badge done">
            最终统计：{finalStats.completed}/{finalStats.total} · 耗时 {finalStats.durationMs}ms
          </span>
        )}
      </div>

      {partial && running && <StatsBlock stats={partial} />}
      {finalStats && !running && <StatsBlock stats={finalStats} />}

      <div className="sample-tabs">
        {samples.map((s) => {
          const r = byId.get(s.id);
          return (
            <button
              key={s.id}
              className={`sample-tab ${current?.sampleId === s.id ? 'active' : ''} ${r ? 'has-result' : ''}`}
              onClick={() => onSelectSample(s.id)}
            >
              {s.name}
              <small>
                rev {s.id === r?.sampleId ? r.sampleRevision : s.revision}
                {r?.error ? ' · 错误' : r ? ` · ${r.stats.ranges} 处` : ''}
              </small>
            </button>
          );
        })}
      </div>

      {!current && <p className="hint">点击“模拟”后，每个样例的结果会在这里流式出现。</p>}
      {current && <SampleDetail result={current} sampleName={samples.find((s) => s.id === current.sampleId)?.name ?? current.sampleId} />}
    </div>
  );
}

function StatsBlock({stats}: {stats: BatchStats}) {
  return (
    <div className={`stats ${stats.phase}`}>
      <div className="stats-title">
        {stats.phase === 'partial' ? '部分统计（仍有样例在执行）' : '最终统计'}
        <span className="stats-progress">
          {stats.completed}/{stats.total}
        </span>
      </div>
      <div className="stats-grid">
        <span>最终范围 <b>{stats.ranges}</b></span>
        <span>整条生效 <b>{stats.applied}</b></span>
        <span>部分生效 <b>{stats.partial}</b></span>
        <span>被覆盖 <b>{stats.overridden}</b></span>
        <span>替换字符 <b>{stats.charsReplaced}</b></span>
        <span className={stats.detectorErrors ? 'warn-text' : ''}>检测器失败 <b>{stats.detectorErrors}</b></span>
        <span className={stats.sampleErrors ? 'err-text' : ''}>错误样例 <b>{stats.sampleErrors}</b></span>
      </div>
      <div className="stats-strategies">
        {(Object.keys(stats.byStrategy) as (keyof typeof stats.byStrategy)[]).map((key) => (
          <span key={key} className="strategy-chip">
            {STRATEGY_LABEL[key]}: {stats.byStrategy[key]}
          </span>
        ))}
      </div>
    </div>
  );
}

function SampleDetail({result, sampleName}: {result: SampleSimulation; sampleName: string}) {
  return (
    <div className="sample-detail">
      <div className="binding-line">
        样例 <b>{sampleName}</b> · 绑定 revision {result.boundRevision}
        {result.revisionChanged && <span className="badge warn">模拟期间样例已更新（当前 rev {result.sampleRevision}）</span>}
        {' · '}策略哈希 <code>{result.policyHash}</code>
      </div>

      {result.error && (
        <div className="sample-error">
          样例执行失败：{result.error.code} — {result.error.message}（不影响其他样例）
        </div>
      )}

      {result.detectorErrors.length > 0 && (
        <div className="detector-errors">
          {result.detectorErrors.map((e, i) => (
            <div key={i} className="detector-error">
              检测器 <code>{e.detectorId}</code> 失败：{e.message}（该检测器按 0 命中处理，其他检测器继续）
            </div>
          ))}
        </div>
      )}

      <div className="text-diff">
        <div>
          <h4>替换后文本</h4>
          <pre className="output-text">{result.output}</pre>
        </div>
      </div>

      <h4>范围溯源（{result.ranges.length} 个最终范围）</h4>
      <ul className="range-list">
        {result.ranges.map((range) => (
          <li key={`${range.start}-${range.end}-${range.ruleId}`} className="range-item">
            <code className="range-coord">[{range.start}, {range.end})</code>
            <span className="range-rule">{range.ruleLabel}</span>
            <span className="range-detector">检测器 {range.detectorId} · 置信 {range.confidence}</span>
            <span className="range-strategy">{STRATEGY_LABEL[range.strategy]}</span>
            <code className="range-repl">{range.replacement}</code>
          </li>
        ))}
      </ul>

      <h4>重叠建议与覆盖解释（{result.proposals.length} 条提议）</h4>
      <ul className="proposal-list">
        {result.proposals.map((p) => (
          <li key={p.key} className={`proposal-item ${p.status}`}>
            <div className="proposal-head">
              <span className={`proposal-status ${p.status}`}>{STATUS_LABEL[p.status]}</span>
              <b>P{p.priority} {p.ruleLabel}</b>
              <code>[{p.start}, {p.end})</code>
              <span className="muted">“{p.value}”</span>
              <span className="muted">
                置信 {p.confidence} / 阈值 {p.threshold}
              </span>
            </div>
            <p className="reason">{p.reason}</p>
            <div className="pieces">
              {p.pieces.map((piece, i) => (
                <span key={i} className={`piece ${piece.status}`}>
                  [{piece.start},{piece.end}) {piece.status === 'applied' ? '生效' : `← ${piece.byRuleLabel}`}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
