import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {FlaskConical, Play, Save, Square, RefreshCw, AlertTriangle} from 'lucide-react';
import type {
  BatchStats,
  Compilation,
  FinalBatchStats,
  PolicyDraft,
  SampleRow,
  SampleSimulation,
  SampleSummary,
} from '../shared/types';
import {api, startSimulation} from './api';
import {PolicyEditor} from './components/PolicyEditor';
import {DiagnosticsPanel} from './components/DiagnosticsPanel';
import {SimulationResults} from './components/SimulationResults';
import {SamplesPanel} from './components/SamplesPanel';

type SaveState =
  | {kind: 'idle'}
  | {kind: 'saving'}
  | {kind: 'saved'; revision: number}
  | {kind: 'conflict'; message: string; serverRevision: number};

export default function App() {
  const [builtinDetectors, setBuiltinDetectors] = useState<{id: string; label: string}[]>([]);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [savedRevision, setSavedRevision] = useState<number>(0);
  const [saveState, setSaveState] = useState<SaveState>({kind: 'idle'});
  const [compilation, setCompilation] = useState<Compilation | null>(null);

  const [samples, setSamples] = useState<SampleRow[]>([]);
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(null);

  // 模拟状态
  const [running, setRunning] = useState(false);
  const [stale, setStale] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [results, setResults] = useState<SampleSimulation[]>([]);
  const [partial, setPartial] = useState<BatchStats | null>(null);
  const [finalStats, setFinalStats] = useState<FinalBatchStats | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [injectFailures, setInjectFailures] = useState(false);

  const cancelRef = useRef<(() => void) | null>(null);
  const compileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSimInputs = useRef<{draft: PolicyDraft; revisions: Map<string, number>} | null>(null);

  // ---------------- 初始加载 ----------------
  useEffect(() => {
    void api.bootstrap().then((b) => setBuiltinDetectors(b.builtinDetectors ?? []));
    void api.getPolicy().then((p) => {
      const {revision, ...body} = p;
      setSavedRevision(revision);
      setDraft(body);
    });
    void refreshSamples();
  }, []);

  const refreshSamples = useCallback(async (): Promise<SampleRow[]> => {
    const summaries = await api.listSamples();
    // 列表只返回 summary，逐个取内容用于编辑（样例集固定且很小）
    const rows = await Promise.all(summaries.map((s: SampleSummary) => api.getSample(s.id)));
    setSamples(rows);
    setSelectedSampleId((cur) => cur ?? rows[0]?.id ?? null);
    return rows;
  }, []);

  // ---------------- 编辑：立即标过期 + 防抖编译 ----------------
  const handleDraftChange = useCallback((next: PolicyDraft) => {
    setDraft(next);
    setStale(true);
    setSaveState({kind: 'idle'});
    if (compileTimer.current) clearTimeout(compileTimer.current);
    compileTimer.current = setTimeout(() => {
      void api.compile(next).then(setCompilation);
    }, 250);
  }, []);

  // 首次草稿就绪后先编译一次
  useEffect(() => {
    if (draft && !compilation) void api.compile(draft).then(setCompilation);
  }, [draft, compilation]);

  // ---------------- 保存（并发 revision 控制） ----------------
  async function savePolicy() {
    if (!draft) return;
    setSaveState({kind: 'saving'});
    try {
      const saved = await api.savePolicy(draft, savedRevision);
      const {revision, ...body} = saved;
      setSavedRevision(revision);
      setDraft(body);
      setSaveState({kind: 'saved', revision});
      setStale(true); // 即便内容相同，落库版本变化也要求重新模拟以绑定新哈希
      void api.compile(body).then(setCompilation);
    } catch (error) {
      const e = error as {status?: number; body?: {current?: {revision: number}; message?: string}};
      if (e.status === 409) {
        const serverRevision = e.body?.current?.revision ?? savedRevision;
        setSaveState({
          kind: 'conflict',
          message: e.body?.message ?? '策略已被其他人保存',
          serverRevision,
        });
      } else {
        setSaveState({kind: 'conflict', message: (error as Error).message, serverRevision: savedRevision});
      }
    }
  }

  /** 并发冲突后：丢弃本地草稿，加载服务端版本 */
  async function adoptServerPolicy() {
    const saved = await api.getPolicy();
    const {revision, ...body} = saved;
    setSavedRevision(revision);
    setDraft(body);
    setSaveState({kind: 'saved', revision});
    setStale(true);
    void api.compile(body).then(setCompilation);
  }

  // ---------------- 样例更新 ----------------
  async function saveSample(sample: SampleRow, content: string) {
    await api.saveSample(sample.id, content, sample.revision);
    // revision 变化：旧结果过期但保留
    setStale(true);
  }

  // 进入工作台后如果样例 revision 与绑定时不同，提示过期
  useEffect(() => {
    if (!lastSimInputs.current || samples.length === 0) return;
    for (const s of samples) {
      const bound = lastSimInputs.current.revisions.get(s.id);
      if (bound !== undefined && bound !== s.revision) {
        setStale(true);
        break;
      }
    }
  }, [samples]);

  // ---------------- 批量模拟（流式 / 可取消） ----------------
  async function runSimulation() {
    if (!draft || !compilation?.valid) return;
    const fresh = await refreshSamples(); // 模拟前拉最新 revision，绑定即以此为准
    const revisions = new Map(fresh.map((s) => [s.id, s.revision]));
    setRunning(true);
    setCancelled(false);
    setSimError(null);
    setResults([]);
    setPartial(null);
    setFinalStats(null);
    lastSimInputs.current = {draft: structuredClone(draft), revisions};

    const failures = injectFailures
      ? {
          // 演示用：让 name_cn 检测器“不可用”，验证单检测器失败不阻断
          name_cn: {code: 'detector_unavailable' as const, message: '模拟注入：姓名服务超时 (503)'},
        }
      : undefined;

    const handle = await startSimulation(
      {draft: structuredClone(draft), detectorFailures: failures},
      {
        onStart: () => undefined,
        onProgress: (event) => {
          setResults((prev) =>
            prev.some((r) => r.sampleId === event.result.sampleId) ? prev : [...prev, event.result],
          );
          setPartial(event.stats);
        },
        onDone: (event) => {
          setResults(event.results);
          setFinalStats(event.stats);
          setPartial(null);
          // 模拟期间样例被别处更新时，结果虽完成但已不是当前绑定 → 保持过期提示
          setStale(event.results.some((r) => r.revisionChanged));
        },
        onCancelled: (event) => {
          setResults(event.results);
          setFinalStats(event.stats);
          setCancelled(true);
          setPartial(null);
        },
        onFatalError: ({body}) => {
          setSimError(body?.message || body?.error || '模拟无法启动');
        },
      },
    );
    cancelRef.current = handle.cancel;
    setRunning(false);
    cancelRef.current = null;
  }

  function cancelSimulation() {
    // 本地立即标记取消，避免读取中断时收不到 cancelled 事件的竞态
    setCancelled(true);
    cancelRef.current?.();
  }

  const canSimulate = useMemo(
    () => Boolean(draft && compilation?.valid && !running && samples.length > 0),
    [draft, compilation, running, samples.length],
  );

  if (!draft) {
    return (
      <main className="shell">
        <header className="topbar">
          <FlaskConical size={20} />
          <strong>文本脱敏审阅工作台</strong>
        </header>
        <p className="loading">加载策略中…</p>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>文本脱敏审阅工作台</strong>
        <small>编辑检测器组合 · 置信阈值 · 替换策略，保存前先对固定样例模拟</small>
        <span className="topbar-spacer" />
        <span className="rev-tag">已保存 rev {savedRevision}</span>
      </header>

      <section className="toolbar">
        <div className="toolbar-group">
          <button className="primary" onClick={() => void savePolicy()} disabled={running || saveState.kind === 'saving'}>
            <Save size={15} />
            {saveState.kind === 'saving' ? '保存中…' : '保存策略'}
          </button>
          {running ? (
            <button className="danger" onClick={cancelSimulation}>
              <Square size={14} /> 取消模拟
            </button>
          ) : (
            <button onClick={() => void runSimulation()} disabled={!canSimulate} title={compilation && !compilation.valid ? '存在编译错误，无法模拟' : ''}>
              <Play size={15} /> 对全部样例模拟
            </button>
          )}
          <button className="ghost" onClick={() => void refreshSamples()}>
            <RefreshCw size={14} /> 刷新样例
          </button>
          <label className="check inject">
            <input type="checkbox" checked={injectFailures} onChange={(e) => setInjectFailures(e.target.checked)} />
            注入姓名检测器失败
          </label>
        </div>
        <div className="toolbar-messages">
          {saveState.kind === 'saved' && <span className="ok-text">已保存为 revision {saveState.revision}</span>}
          {saveState.kind === 'conflict' && (
            <span className="conflict-banner">
              <AlertTriangle size={14} /> {saveState.message}
              <button className="mini" onClick={() => void adoptServerPolicy()}>
                加载服务端版本（rev {saveState.serverRevision}）
              </button>
            </span>
          )}
          {simError && <span className="err-text">{simError}</span>}
        </div>
      </section>

      <section className="workspace-3">
        <div className="pane pane-left">
          <PolicyEditor
            draft={draft}
            builtinDetectors={builtinDetectors}
            onChange={handleDraftChange}
            disabled={running}
          />
        </div>

        <div className="pane pane-mid">
          <DiagnosticsPanel diagnostics={compilation?.diagnostics ?? []} hash={compilation?.hash} />
          <hr />
          <SamplesPanel samples={samples} onSave={saveSample} onRefresh={refreshSamples} disabled={running} />
        </div>

        <div className="pane pane-right">
          <SimulationResults
            samples={samples}
            results={results}
            running={running}
            cancelled={cancelled}
            partial={partial}
            finalStats={finalStats}
            stale={stale && !running}
            selectedSampleId={selectedSampleId}
            onSelectSample={setSelectedSampleId}
          />
        </div>
      </section>
    </main>
  );
}
