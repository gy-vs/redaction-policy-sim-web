import express from 'express';
import {fileURLToPath} from 'node:url';
import type {Policy, SampleResult, SimEvent, SimulationSummary} from '../shared/domain';
import {compilePolicy} from '../shared/compile';
import {simulateSample} from '../shared/simulate';
import {createStore, type Store} from './store';

function parsePolicy(body: unknown): Policy | null {
  if (typeof body !== 'object' || body === null) return null;
  const rules = (body as {rules?: unknown}).rules;
  if (!Array.isArray(rules)) return null;
  const parsed: Policy = {rules: []};
  for (const raw of rules) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.detector !== 'string') return null;
    parsed.rules.push({
      id: r.id,
      name: typeof r.name === 'string' ? r.name : r.id,
      detector: r.detector as Policy['rules'][number]['detector'],
      threshold: typeof r.threshold === 'number' ? r.threshold : NaN,
      strategy: (typeof r.strategy === 'string' ? r.strategy : 'mask') as Policy['rules'][number]['strategy'],
      base: typeof r.base === 'string' ? r.base : null,
      replacement: typeof r.replacement === 'string' ? r.replacement : '',
    });
  }
  return parsed;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function createApp(store: Store = createStore()) {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) => {
    const policy = store.getPolicy();
    res.json({
      family: 'redaction-policy-workbench',
      policy,
      samples: store.listSamples(),
    });
  });

  app.get('/api/policy', (_req, res) => res.json(store.getPolicy()));

  // 仅编译：返回 hash + issues，前端编辑时实时调用
  app.post('/api/policy/compile', (req, res) => {
    const policy = parsePolicy(req.body);
    if (!policy) return res.status(400).json({error: 'malformed_policy'});
    res.json(compilePolicy(policy));
  });

  // 保存：编译校验 + 乐观并发
  app.put('/api/policy', (req, res) => {
    const policy = parsePolicy(req.body?.policy);
    const expectedRevision = req.body?.expectedRevision;
    if (!policy || typeof expectedRevision !== 'number') {
      return res.status(400).json({error: 'malformed_request'});
    }
    const compiled = compilePolicy(policy);
    if (compiled.issues.length > 0) {
      return res.status(422).json({ok: false, issues: compiled.issues});
    }
    const result = store.savePolicy(expectedRevision, policy);
    if (!result.ok) return res.status(409).json({ok: false, conflict: result.conflict});
    res.json({ok: true, revision: result.revision});
  });

  app.get('/api/samples', (_req, res) => res.json(store.listSamples()));

  app.put('/api/samples/:id', (req, res) => {
    const content = req.body?.content;
    const expectedRevision = req.body?.expectedRevision;
    if (typeof content !== 'string' || typeof expectedRevision !== 'number') {
      return res.status(400).json({error: 'malformed_request'});
    }
    const result = store.updateSample(req.params.id, content, expectedRevision);
    if ('notFound' in result && result.notFound) return res.status(404).json({error: 'not_found'});
    if (!result.ok) return res.status(409).json(result);
    res.json(result.sample);
  });

  // 批量模拟：NDJSON 流式返回；客户端断开（AbortController）即取消；
  // 单个样例失败只标记该样例，不阻断后续样例。
  app.post('/api/simulate', async (req, res) => {
    const policy = parsePolicy(req.body?.policy);
    if (!policy) return res.status(400).json({error: 'malformed_policy'});
    const compiled = compilePolicy(policy);
    const samples = store.listSamples();
    const sampleRevision = Math.max(...samples.map(s => s.revision));

    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.flushHeaders();

    let cancelled = false;
    // 响应流提前关闭（客户端 AbortController）即取消；正常结束时 writableEnded 已为 true
    res.on('close', () => {
      if (!res.writableEnded) cancelled = true;
    });
    const send = (event: SimEvent) => {
      if (!cancelled) res.write(JSON.stringify(event) + '\n');
    };

    const summary: SimulationSummary = {
      policyHash: compiled.hash,
      sampleRevision,
      samples: samples.length,
      completed: 0,
      failed: 0,
      winners: 0,
      overridden: 0,
      partial: true,
    };
    send({type: 'started', policyHash: compiled.hash, sampleRevision, total: samples.length});

    for (const sample of samples) {
      if (cancelled) break;
      await sleep(120); // 模拟耗时，也让取消可被观察
      let result: SampleResult;
      try {
        result = simulateSample(compiled, sample);
      } catch (error) {
        result = {
          sampleId: sample.id,
          sampleRevision: sample.revision,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          input: sample.content,
          decisions: [],
          output: '',
          stats: {findings: 0, winners: 0, overridden: 0, byRule: {}},
        };
      }
      summary.completed += 1;
      if (result.status === 'error') {
        summary.failed += 1;
      } else {
        summary.winners += result.stats.winners;
        summary.overridden += result.stats.overridden;
      }
      send({type: 'sample', result, summary: {...summary}});
    }

    summary.partial = false;
    send({type: 'done', summary: {...summary}, cancelled});
    res.end();
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
