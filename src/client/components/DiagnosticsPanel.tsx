import type {CompileDiagnostic} from '../../shared/types';

const CODE_LABEL: Record<CompileDiagnostic['code'], string> = {
  invalid_reference: '无效引用',
  invalid_threshold: '阈值越界',
  duplicate_id: '标识冲突',
  cycle_in_derivation: '循环派生',
  unreachable_rule: '永远不可达',
};

export function DiagnosticsPanel({diagnostics, hash}: {diagnostics: CompileDiagnostic[]; hash?: string}) {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  return (
    <div className="diagnostics">
      <div className="diag-head">
        <span className={`diag-count ${errors.length ? 'bad' : 'ok'}`}>{errors.length} 错误</span>
        <span className={`diag-count ${warnings.length ? 'warn' : 'ok'}`}>{warnings.length} 警告</span>
        {hash && <code className="hash" title="模拟绑定的策略草稿哈希">草稿哈希 {hash}</code>}
      </div>
      {diagnostics.length === 0 && <p className="hint ok-text">编译通过：没有无效引用、循环或不可达规则。</p>}
      <ul className="diag-list">
        {diagnostics.map((d, i) => (
          <li key={`${d.code}-${d.subjectId}-${i}`} className={`diag-item ${d.severity}`}>
            <span className="diag-code">{CODE_LABEL[d.code]}</span>
            <span>{d.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
