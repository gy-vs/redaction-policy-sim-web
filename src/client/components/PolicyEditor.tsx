import type {
  DerivedDetector,
  PolicyDraft,
  ReplacementStrategy,
  RuleDraft,
} from '../../shared/types';
import {STRATEGIES} from '../../shared/strategyMeta';

interface Props {
  draft: PolicyDraft;
  builtinDetectors: {id: string; label: string}[];
  onChange: (next: PolicyDraft) => void;
  disabled?: boolean;
}

let seq = 0;
export function newId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

const STRATEGY_LABEL: Record<ReplacementStrategy, string> = {
  mask: '掩码 ***',
  label: '标签 [名称]',
  redact: '涂黑 ██',
  hash: '哈希摘要',
  keep: '保留原文',
};

export function PolicyEditor({draft, builtinDetectors, onChange, disabled}: Props) {
  const detectorOptions = [
    ...builtinDetectors.map((d) => ({id: d.id, label: `${d.label}（内置）`})),
    ...draft.detectors.map((d) => ({id: d.id, label: `${d.label || d.id}（派生）`})),
  ];

  const updateRule = (id: string, patch: Partial<RuleDraft>) =>
    onChange({...draft, rules: draft.rules.map((r) => (r.id === id ? {...r, ...patch} : r))});

  const moveRule = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= draft.rules.length) return;
    const rules = [...draft.rules];
    [rules[index], rules[target]] = [rules[target], rules[index]];
    onChange({...draft, rules});
  };

  const removeRule = (id: string) =>
    onChange({...draft, rules: draft.rules.filter((r) => r.id !== id)});

  const addRule = () =>
    onChange({
      ...draft,
      rules: [
        ...draft.rules,
        {
          id: newId('r'),
          detectorId: builtinDetectors[0]?.id ?? '',
          minConfidence: 0.8,
          strategy: 'mask',
          label: '新规则',
          enabled: true,
        },
      ],
    });

  const updateDetector = (id: string, patch: Partial<DerivedDetector>) =>
    onChange({
      ...draft,
      detectors: draft.detectors.map((d) => (d.id === id ? {...d, ...patch} : d)),
    });

  const toggleSource = (detector: DerivedDetector, sourceId: string) => {
    const sources = detector.sources.includes(sourceId)
      ? detector.sources.filter((s) => s !== sourceId)
      : [...detector.sources, sourceId];
    updateDetector(detector.id, {sources});
  };

  const addDetector = () =>
    onChange({
      ...draft,
      detectors: [
        ...draft.detectors,
        {
          id: newId('det'),
          label: '新派生检测器',
          sources: [builtinDetectors[0]?.id].filter(Boolean),
          combine: 'union',
          window: 0,
        },
      ],
    });

  const removeDetector = (id: string) =>
    onChange({...draft, detectors: draft.detectors.filter((d) => d.id !== id)});

  return (
    <div className="editor">
      <input
        className="policy-name"
        aria-label="策略名称"
        value={draft.name}
        disabled={disabled}
        onChange={(e) => onChange({...draft, name: e.target.value})}
      />

      <section className="editor-section">
        <div className="section-head">
          <h3>检测器组合</h3>
          <button className="mini" onClick={addDetector} disabled={disabled}>
            + 新建派生
          </button>
        </div>
        <p className="hint">派生检测器由内置检测器或其他派生检测器取并集/交集构成；交集可设置邻近窗口（字符，0=必须重叠）。</p>
        <div className="detector-list">
          {draft.detectors.map((d) => (
            <div className="card detector-card" key={d.id}>
              <div className="card-row">
                <input
                  aria-label="检测器名称"
                  value={d.label}
                  disabled={disabled}
                  onChange={(e) => updateDetector(d.id, {label: e.target.value})}
                />
                <code className="detector-id">{d.id}</code>
                <button className="mini danger" onClick={() => removeDetector(d.id)} disabled={disabled}>
                  删除
                </button>
              </div>
              <div className="card-row">
                <label className="field">
                  组合方式
                  <select
                    value={d.combine}
                    disabled={disabled}
                    onChange={(e) => updateDetector(d.id, {combine: e.target.value as DerivedDetector['combine']})}
                  >
                    <option value="union">并集 union</option>
                    <option value="intersect">交集 intersect</option>
                  </select>
                </label>
                <label className="field">
                  邻近窗口
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={d.window}
                    disabled={disabled || d.combine !== 'intersect'}
                    onChange={(e) => updateDetector(d.id, {window: Number(e.target.value)})}
                  />
                </label>
              </div>
              <div className="source-grid">
                {builtinDetectors.map((b) => (
                  <label key={b.id} className="check">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={d.sources.includes(b.id)}
                      onChange={() => toggleSource(d, b.id)}
                    />
                    {b.label}
                  </label>
                ))}
                {draft.detectors
                  .filter((other) => other.id !== d.id)
                  .map((other) => (
                    <label key={other.id} className="check">
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={d.sources.includes(other.id)}
                        onChange={() => toggleSource(d, other.id)}
                      />
                      {other.label || other.id}
                    </label>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="editor-section">
        <div className="section-head">
          <h3>规则（自上而下 = 优先级）</h3>
          <button className="mini" onClick={addRule} disabled={disabled}>
            + 新建规则
          </button>
        </div>
        <p className="hint">
          多个检测器给出重叠范围时，编号小的规则先占用字符；阈值边界包含（置信度 ≥ 阈值即提议）。停用的规则不参与模拟，也不会遮蔽后续规则。
        </p>
        <div className="rule-list">
          {draft.rules.map((rule, index) => (
            <div className={`card rule-card ${rule.enabled ? '' : 'disabled-card'}`} key={rule.id}>
              <div className="priority-badge" title={`优先级 P${index}`}>
                P{index}
              </div>
              <div className="rule-body">
                <div className="card-row">
                  <input
                    className="rule-label"
                    aria-label="规则名称"
                    value={rule.label}
                    disabled={disabled}
                    onChange={(e) => updateRule(rule.id, {label: e.target.value})}
                  />
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      disabled={disabled}
                      onChange={(e) => updateRule(rule.id, {enabled: e.target.checked})}
                    />
                    启用
                  </label>
                </div>
                <div className="card-row wrap">
                  <label className="field">
                    检测器
                    <select
                      value={rule.detectorId}
                      disabled={disabled}
                      onChange={(e) => updateRule(rule.id, {detectorId: e.target.value})}
                    >
                      {detectorOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    置信阈值 ≥
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={rule.minConfidence}
                      disabled={disabled}
                      onChange={(e) => updateRule(rule.id, {minConfidence: Number(e.target.value)})}
                    />
                  </label>
                  <label className="field">
                    替换策略
                    <select
                      value={rule.strategy}
                      disabled={disabled}
                      onChange={(e) => updateRule(rule.id, {strategy: e.target.value as ReplacementStrategy})}
                    >
                      {STRATEGIES.map((s) => (
                        <option key={s} value={s}>
                          {STRATEGY_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
              <div className="rule-actions">
                <button className="mini" onClick={() => moveRule(index, -1)} disabled={disabled || index === 0} title="上移（提高优先级）">
                  ↑
                </button>
                <button
                  className="mini"
                  onClick={() => moveRule(index, 1)}
                  disabled={disabled || index === draft.rules.length - 1}
                  title="下移（降低优先级）"
                >
                  ↓
                </button>
                <button className="mini danger" onClick={() => removeRule(rule.id)} disabled={disabled}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
