import type {CompileIssue, Policy, Rule} from '../../shared/domain';
import {DETECTOR_IDS, DETECTOR_LABELS, STRATEGY_LABELS} from '../../shared/domain';
import {ArrowDown, ArrowUp, Plus, Trash2} from 'lucide-react';

interface Props {
  draft: Policy;
  issues: CompileIssue[];
  onChange(next: Policy): void;
}

const STRATEGIES = Object.keys(STRATEGY_LABELS) as Array<keyof typeof STRATEGY_LABELS>;

export function RuleEditor({draft, issues, onChange}: Props) {
  const update = (id: string, patch: Partial<Rule>) =>
    onChange({rules: draft.rules.map(r => (r.id === id ? {...r, ...patch} : r))});

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= draft.rules.length) return;
    const rules = [...draft.rules];
    const [rule] = rules.splice(index, 1);
    rules.splice(target, 0, rule);
    onChange({rules});
  };

  const addRule = () => {
    let n = draft.rules.length + 1;
    while (draft.rules.some(r => r.id === `r-custom-${n}`)) n += 1;
    onChange({
      rules: [
        ...draft.rules,
        {
          id: `r-custom-${n}`,
          name: `自定义规则 ${n}`,
          detector: 'phone',
          threshold: 0.5,
          strategy: 'mask',
          base: null,
          replacement: '',
        },
      ],
    });
  };

  const removeRule = (id: string) => onChange({rules: draft.rules.filter(r => r.id !== id)});

  const issuesFor = (id: string) => issues.filter(i => i.ruleId === id);

  return (
    <div className="rule-editor">
      <div className="rule-editor-head">
        <h2>检测规则（自上而下优先级递减）</h2>
        <button onClick={addRule}>
          <Plus size={14} />
          添加规则
        </button>
      </div>
      {draft.rules.map((rule, index) => (
        <div className="rule-card" key={rule.id} data-testid={`rule-${rule.id}`}>
          <div className="rule-card-head">
            <span className="order">#{index + 1}</span>
            <input
              aria-label="规则名称"
              value={rule.name}
              onChange={e => update(rule.id, {name: e.target.value})}
            />
            <button title="上移" onClick={() => move(index, -1)} disabled={index === 0}>
              <ArrowUp size={14} />
            </button>
            <button
              title="下移"
              onClick={() => move(index, 1)}
              disabled={index === draft.rules.length - 1}
            >
              <ArrowDown size={14} />
            </button>
            <button title="删除" onClick={() => removeRule(rule.id)}>
              <Trash2 size={14} />
            </button>
          </div>
          <div className="rule-grid">
            <label>
              检测器
              <select
                value={rule.detector}
                onChange={e => update(rule.id, {detector: e.target.value as Rule['detector']})}
              >
                {DETECTOR_IDS.map(id => (
                  <option key={id} value={id}>
                    {DETECTOR_LABELS[id]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              置信阈值（{rule.threshold.toFixed(2)}）
              <input
                aria-label={`阈值-${rule.id}`}
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={rule.threshold}
                onChange={e => update(rule.id, {threshold: Number(e.target.value)})}
              />
            </label>
            <label>
              替换策略
              <select
                value={rule.strategy}
                onChange={e => update(rule.id, {strategy: e.target.value as Rule['strategy']})}
              >
                {STRATEGIES.map(s => (
                  <option key={s} value={s}>
                    {STRATEGY_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              派生自（可选）
              <select
                value={rule.base ?? ''}
                onChange={e => update(rule.id, {base: e.target.value === '' ? null : e.target.value})}
              >
                <option value="">（无）</option>
                {draft.rules
                  .filter(r => r.id !== rule.id)
                  .map(r => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            {rule.strategy === 'redact' && (
              <label className="wide">
                替换文案
                <input
                  value={rule.replacement}
                  onChange={e => update(rule.id, {replacement: e.target.value})}
                />
              </label>
            )}
          </div>
          {issuesFor(rule.id).map(issue => (
            <p className="issue" key={issue.code + issue.message} role="alert">
              [{issue.code}] {issue.message}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}
