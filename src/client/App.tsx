import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {FlaskConical, Play, Save, Square} from 'lucide-react';
import type {
  CompiledPolicy,
  Policy,
  PolicyRevision,
  Sample,
  SampleResult,
  SimulationSummary,
} from '../shared/domain';
import {canonicalizePolicy} from '../shared/canonical';
import {api, streamSimulation} from './api';
import {RuleEditor} from './components/RuleEditor';
import {SampleResultView} from './components/SampleResultView';

interface SimState {
  /** 产生本次结果时的草稿快照与样例 revision，用于过期判定 */
  policyCanonical: string;
  policyHash: string;
  sampleRevision: number;
  results: SampleResult[];
  summary: SimulationSummary | null;
  final: boolean;
  cancelled: boolean;
}

const maxSampleRevision = (samples: Sample[]) =>
  samples.reduce((max, s) => Math.max(max, s.revision), 0);

export default function App() {
  const [serverRevision, setServerRevision] = useState<PolicyRevision | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [compiled, setCompiled] = useState<CompiledPolicy | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [selectedSample, setSelectedSample] = useState('basic');
  const [sampleDrafts, setSampleDrafts] = useState<Record<string, string>>({});
  const [sim, setSim] = useState<SimState | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState<PolicyRevision | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api.bootstrap().then(({policy, samples}) => {
      setServerRevision(policy);
      setDraft(policy.policy);
      setSamples(samples);
      setSampleDrafts(Object.fromEntries(samples.map(s => [s.id, s.content])));
    });
  }, []);

  // 草稿变更后防抖编译，拿到最新 hash 与校验问题
  useEffect(() => {
    if (!draft) return;
    const timer = setTimeout(() => {
      api.compile(draft).then(setCompiled).catch(() => setCompiled(null));
    }, 200);
    return () => clearTimeout(timer);
  }, [draft]);

  // 任何字段修改都会改变 canonical 文本或样例 revision → 旧结果立即过期，但保留展示用于对照
  const stale = useMemo(() => {
    if (!sim || !draft) return false;
    return (
      sim.policyCanonical !== canonicalizePolicy(draft) ||
      sim.sampleRevision !== maxSampleRevision(samples)
    );
  }, [sim, draft, samples]);

  const runSimulation = useCallback(async () => {
    if (!draft || running) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const snapshot: SimState = {
      policyCanonical: canonicalizePolicy(draft),
      policyHash: compiled?.hash ?? '',
      sampleRevision: maxSampleRevision(samples),
      results: [],
      summary: null,
      final: false,
      cancelled: false,
    };
    setSim(snapshot);
    setRunning(true);
    setNotice('');
    try {
      await streamSimulation(
        draft,
        event => {
          setSim(prev => {
            if (!prev) return prev;
            switch (event.type) {
              case 'started':
                return {...prev, policyHash: event.policyHash, sampleRevision: event.sampleRevision};
              case 'sample':
                return {...prev, results: [...prev.results, event.result], summary: event.summary};
              case 'done':
                return {...prev, summary: event.summary, final: true, cancelled: event.cancelled};
            }
          });
        },
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        // 客户端主动取消：把已有部分结果固化为“已取消的终态”
        setSim(prev =>
          prev
            ? {
                ...prev,
                final: true,
                cancelled: true,
                summary: prev.summary ? {...prev.summary, partial: false} : null,
              }
            : prev,
        );
      } else {
        setNotice(`模拟失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      setRunning(false);
    }
  }, [draft, running, compiled, samples]);

  const cancelSimulation = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const savePolicy = useCallback(async () => {
    if (!draft || !serverRevision) return;
    setNotice('');
    setConflict(null);
    const res = await api.savePolicy(draft, serverRevision.revision);
    if (res.status === 409) {
      const body = await res.json();
      setConflict(body.conflict.current);
      return;
    }
    if (res.status === 422) {
      const body = await res.json();
      setNotice(`保存被拒绝：${body.issues.map((i: {message: string}) => i.message).join('；')}`);
      return;
    }
    const body = await res.json();
    setServerRevision(body.revision);
    setNotice(`已保存为策略 revision ${body.revision.revision}`);
  }, [draft, serverRevision]);

  const reloadPolicy = useCallback(async () => {
    const res = await fetch('/api/policy');
    const latest: PolicyRevision = await res.json();
    setServerRevision(latest);
    setDraft(latest.policy);
    setConflict(null);
  }, []);

  const saveSample = useCallback(
    async (id: string) => {
      const sample = samples.find(s => s.id === id);
      if (!sample) return;
      const res = await api.saveSample(id, sampleDrafts[id] ?? sample.content, sample.revision);
      if (res.status === 409) {
        setNotice(`样例 ${id} 保存冲突，请刷新后重试`);
        return;
      }
      const updated: Sample = await res.json();
      setSamples(prev => prev.map(s => (s.id === id ? updated : s)));
      setNotice(`样例 ${id} 已更新到 revision ${updated.revision}，旧模拟结果已标记过期`);
    },
    [samples, sampleDrafts],
  );

  if (!draft || !serverRevision) {
    return <main className="shell">加载中…</main>;
  }

  const selected = samples.find(s => s.id === selectedSample);
  const selectedResult = sim?.results.find(r => r.sampleId === selectedSample);

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>文本脱敏审阅工作台</strong>
        <small>
          服务端策略 revision {serverRevision.revision} · 草稿哈希 {compiled?.hash ?? '…'}
        </small>
        <span className="spacer" />
        <button className="primary" onClick={savePolicy} disabled={!!compiled?.issues.length}>
          <Save size={15} />
          保存策略
        </button>
        {running ? (
          <button onClick={cancelSimulation}>
            <Square size={15} />
            取消模拟
          </button>
        ) : (
          <button onClick={runSimulation}>
            <Play size={15} />
            运行模拟
          </button>
        )}
      </header>

      {(notice || conflict) && (
        <div className="banner" role="status">
          {notice}
          {conflict && (
            <span>
              保存冲突：服务端已是 revision {conflict.revision}（哈希 {conflict.hash}）。
              <button onClick={reloadPolicy}>加载最新策略</button>
            </span>
          )}
        </div>
      )}

      <section className="workspace">
        <aside className="pane">
          <RuleEditor draft={draft} issues={compiled?.issues ?? []} onChange={setDraft} />
        </aside>

        <section className="pane">
          <h2>固定样例集</h2>
          <div className="sample-tabs">
            {samples.map(s => (
              <button
                key={s.id}
                className={s.id === selectedSample ? 'active' : ''}
                onClick={() => setSelectedSample(s.id)}
              >
                {s.name}（rev {s.revision}）
                {sim?.results.find(r => r.sampleId === s.id)?.status === 'error' && ' ⚠'}
              </button>
            ))}
          </div>
          {selected && (
            <>
              <textarea
                aria-label="样例内容"
                value={sampleDrafts[selected.id] ?? selected.content}
                onChange={e =>
                  setSampleDrafts(prev => ({...prev, [selected.id]: e.target.value}))
                }
              />
              <div className="toolbar">
                <button onClick={() => saveSample(selected.id)}>
                  <Save size={14} />
                  保存样例（rev {selected.revision} → {selected.revision + 1}）
                </button>
              </div>
              <h3>模拟输出</h3>
              {selectedResult ? (
                <>
                  {stale && <p className="stale-badge">已过期：草稿或样例已变更，结果仅用于对照</p>}
                  <SampleResultView result={selectedResult} />
                </>
              ) : (
                <p className="muted">{running ? '等待该样例的流式结果…' : '尚未运行模拟'}</p>
              )}
            </>
          )}
        </section>

        <aside className="pane">
          <h2>模拟统计</h2>
          {sim?.summary ? (
            <div className={stale ? 'summary stale' : 'summary'}>
              <p>
                <span className={sim.final ? 'pill final' : 'pill partial'}>
                  {sim.final ? (sim.cancelled ? '已取消（部分结果）' : '最终统计') : '部分统计（进行中）'}
                </span>
                {stale && <span className="pill stale-pill">已过期</span>}
              </p>
              <dl>
                <dt>绑定草稿哈希</dt>
                <dd>{sim.policyHash}</dd>
                <dt>绑定样例 revision</dt>
                <dd>{sim.sampleRevision}</dd>
                <dt>完成样例</dt>
                <dd>
                  {sim.summary.completed}/{sim.summary.samples}（失败 {sim.summary.failed}）
                </dd>
                <dt>生效范围</dt>
                <dd>{sim.summary.winners}</dd>
                <dt>被覆盖候选</dt>
                <dd>{sim.summary.overridden}</dd>
              </dl>
              {stale && (
                <p className="muted">
                  对照信息：当前草稿哈希 {compiled?.hash ?? '…'}，当前样例 revision{' '}
                  {maxSampleRevision(samples)}。上方统计仍基于旧绑定，可用于前后对照。
                </p>
              )}
            </div>
          ) : (
            <p className="muted">{running ? '等待首个样例…' : '尚未运行模拟'}</p>
          )}
        </aside>
      </section>
    </main>
  );
}
