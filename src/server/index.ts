import express from 'express';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {
  BatchStats,
  FinalBatchStats,
  PolicyDraft,
  SampleRow,
  SampleSimulation,
  SimEvent,
  StoredPolicy,
} from '../shared/types.js';
import {BUILTIN_DETECTORS, compilePolicy} from './policyCompiler.js';
import {aggregateStats, simulateBatch} from './simulator.js';
import type {FailurePlan} from './detectorEngine.js';

// ----------------------------- 内存数据 -----------------------------

function initialSamples(): SampleRow[] {
  return [
    {
      id: 'alpha',
      name: '客户工单 · 张三',
      revision: 3,
      updatedAt: new Date(0).toISOString(),
      content: [
        '联系人：张三，手机 13812345678',
        '邮箱 zhangsan@example.com，备用 zhang_san@mail.cn',
        '身份证号 11010119900307851X',
        '地址：浙江省杭州市西湖区文三路 138 号',
        'api_key: sk-live-9f8e7d6c5b4a3210',
      ].join('\n'),
    },
    {
      id: 'beta',
      name: '退款登记 · 李四',
      revision: 5,
      updatedAt: new Date(1000).toISOString(),
      content: [
        '李四先生您好，退款将退回卡号 6222021234567890123',
        '联系电话 0571-87654321，邮箱 lisi@corp.example.com',
        '我们会在 3 个工作日内处理。',
      ].join('\n'),
    },
    {
      id: 'gamma',
      name: '无敏感信息 · 公告',
      revision: 1,
      updatedAt: new Date(2000).toISOString(),
      content: '本系统将于本周六凌晨 2:00-4:00 升级维护，期间暂停服务。',
    },
    {
      id: 'delta',
      name: '边界与重叠样例',
      revision: 2,
      updatedAt: new Date(3000).toISOString(),
      content: [
        '低置信姓名 王五（阈值边界演示）',
        'wangwu@demo.io 同时命中邮箱与通用模式',
        'token=abc.def.ghi 与口令短语密钥：XYZ 相邻出现',
      ].join('\n'),
    },
  ];
}

let samples: SampleRow[] = initialSamples();

function buildDefaultPolicy(): StoredPolicy {
  return {
    name: '默认脱敏策略',
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    detectors: [
      {
        id: 'contact',
        label: '联系方式（邮箱∪电话）',
        sources: ['email', 'phone'],
        combine: 'union',
        window: 0,
      },
      {
        id: 'contact_secret',
        label: '联系方式与密钥邻近（交集）',
        sources: ['contact', 'secret'],
        combine: 'intersect',
        window: 40,
      },
    ],
    rules: [
      {
        id: 'r-secret',
        detectorId: 'secret',
        minConfidence: 0,
        strategy: 'redact',
        label: '密钥整段涂黑',
        enabled: true,
      },
      {
        id: 'r-id',
        detectorId: 'id_card',
        minConfidence: 0.8,
        strategy: 'mask',
        label: '身份证掩码',
        enabled: true,
      },
      {
        id: 'r-bank',
        detectorId: 'bank_card',
        minConfidence: 0.8,
        strategy: 'mask',
        label: '银行卡掩码',
        enabled: true,
      },
      {
        id: 'r-contact-label',
        detectorId: 'contact',
        minConfidence: 0.7,
        strategy: 'label',
        label: '联系方式打标签',
        enabled: true,
      },
      {
        id: 'r-email-hash-low',
        detectorId: 'email',
        minConfidence: 0.9,
        strategy: 'hash',
        label: '高置信邮箱哈希（示例：被更高阈值遮蔽时会报不可达）',
        enabled: false,
      },
      {
        id: 'r-name',
        detectorId: 'name_cn',
        minConfidence: 0.6,
        strategy: 'label',
        label: '中文姓名标签',
        enabled: true,
      },
      {
        id: 'r-address',
        detectorId: 'address',
        minConfidence: 0.6,
        strategy: 'label',
        label: '地址标签',
        enabled: true,
      },
    ],
  };
}

let policy: StoredPolicy = buildDefaultPolicy();

// 测试隔离：重置全部内存数据
export function resetStateForTests(): void {
  samples = initialSamples();
  policy = buildDefaultPolicy();
  jobs.clear();
}

// ----------------------------- 模拟任务 -----------------------------

interface Job {
  id: string;
  controller: AbortController;
  cancelled: boolean;
  finished: boolean;
  /** 任务开始时绑定的 (policyHash, 样例 revision) 快照 */
  binding: {sampleId: string; revision: number}[];
  policyHash: string;
  startedAt: number;
  results: SampleSimulation[];
  total: number;
}

const jobs = new Map<string, Job>();

interface SimulateRequest {
  draft?: PolicyDraft;
  sampleIds?: string[];
  /** 测试注入：检测器失败 */
  detectorFailures?: Record<string, {code: 'detector_unavailable' | 'detector_error'; message: string}>;
  /** 测试注入：每个检测器延迟 ms */
  delayMs?: number;
}

function draftIsValidBody(value: unknown): value is PolicyDraft {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.rules) && Array.isArray(v.detectors);
}

export function createApp() {
  resetStateForTests();
  const app = express();
  app.use(express.json({limit: '2mb'}));

  // ---------------- 元数据 ----------------
  app.get('/api/bootstrap', (_req, res) =>
    res.json({
      family: 'document-redaction',
      count: samples.length,
      builtinDetectors: BUILTIN_DETECTORS,
    }),
  );

  // ---------------- 策略：读取 / 编译（不落库）/ 并发保存 ----------------
  app.get('/api/policy', (_req, res) => res.json(policy));

  app.post('/api/policy/compile', (req, res) => {
    if (!draftIsValidBody(req.body)) {
      return res.status(400).json({error: 'invalid_draft', message: '草稿必须包含 rules 与 detectors 数组'});
    }
    const compilation = compilePolicy(req.body);
    // 无效草稿不返回 500：诊断本身就是编译结果；valid=false 时前端禁止模拟/保存
    res.json(compilation);
  });

  app.put('/api/policy', (req, res) => {
    if (!draftIsValidBody(req.body)) {
      return res.status(400).json({error: 'invalid_draft', message: '草稿必须包含 rules 与 detectors 数组'});
    }
    const expectedRevision = Number((req.body as unknown as Record<string, unknown>).revision);
    if (!Number.isInteger(expectedRevision)) {
      return res.status(400).json({error: 'invalid_revision', message: '缺少 revision'});
    }
    // 并发保存：revision 不匹配直接 409
    if (expectedRevision !== policy.revision) {
      return res
        .status(409)
        .json({error: 'revision_conflict', message: '策略已被其他人保存，请刷新后合并修改', current: policy});
    }
    const compilation = compilePolicy(req.body);
    if (!compilation.valid) {
      return res.status(422).json({
        error: 'compilation_failed',
        message: '策略存在编译错误，无法保存',
        diagnostics: compilation.diagnostics,
      });
    }
    policy = {
      name: String(req.body.name ?? policy.name),
      detectors: req.body.detectors,
      rules: req.body.rules,
      revision: policy.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    res.json(policy);
  });

  // ---------------- 样例：列表 / 读取 / 更新（revision 并发控制） ----------------
  app.get('/api/samples', (_req, res) =>
    res.json(
      samples.map(({content, ...summary}) => summary),
    ),
  );

  app.get('/api/samples/:id', (req, res) => {
    const row = samples.find((s) => s.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });

  app.put('/api/samples/:id', (req, res) => {
    const row = samples.find((s) => s.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (Number(req.body.revision) !== row.revision) {
      return res.status(409).json({
        error: 'revision_conflict',
        message: `样例已更新到 revision ${row.revision}，你的修改基于旧 revision ${req.body.revision}`,
        current: row,
      });
    }
    row.content = String(req.body.content ?? '');
    if (typeof req.body.name === 'string' && req.body.name.trim()) row.name = req.body.name;
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json(row);
  });

  // ---------------- 批量模拟（NDJSON 流式 + 可取消） ----------------
  app.post('/api/simulate', async (req, res) => {
    const body = (req.body ?? {}) as SimulateRequest;
    if (!draftIsValidBody(body.draft)) {
      return res.status(400).json({error: 'invalid_draft'});
    }
    const compilation = compilePolicy(body.draft);
    if (!compilation.valid) {
      return res.status(422).json({error: 'compilation_failed', diagnostics: compilation.diagnostics});
    }

    const requestedIds = body.sampleIds?.length
      ? body.sampleIds
      : samples.map((s) => s.id);
    const targets = samples.filter((s) => requestedIds.includes(s.id));
    if (targets.length === 0) {
      return res.status(400).json({error: 'no_samples', message: '没有可模拟的样例'});
    }
    // 绑定：任务开始瞬间快照 policyHash 与每个样例的 revision
    const binding = targets.map((s) => ({sampleId: s.id, revision: s.revision}));
    const policyHash = compilation.hash!;

    const failures: FailurePlan | undefined = body.detectorFailures
      ? new Map(Object.entries(body.detectorFailures))
      : undefined;

    const controller = new AbortController();
    const job: Job = {
      id: randomUUID(),
      controller,
      cancelled: false,
      finished: false,
      binding,
      policyHash,
      startedAt: Date.now(),
      results: [],
      total: targets.length,
    };
    jobs.set(job.id, job);

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Sim-Job-Id', job.id);
    res.flushHeaders?.();

    const send = (event: SimEvent): void => {
      res.write(JSON.stringify(event) + '\n');
    };

    send({type: 'start', jobId: job.id, policyHash, total: targets.length, binding});

    // 客户端在响应完成前断开才视为取消（req 'close' 在 Express 5 响应结束后也会触发）
    res.on('close', () => {
      if (!job.finished && !res.writableEnded) {
        job.cancelled = true;
        controller.abort();
      }
    });

    const pushProgress = async (result: SampleSimulation, index: number, total: number) => {
      job.results.push(result);
      const stats: BatchStats = aggregateStats(job.results, total, 'partial');
      send({type: 'progress', stats, result});
    };

    const {results, cancelled} = await simulateBatch(body.draft, compilation, targets, {
      failures,
      delayMs: typeof body.delayMs === 'number' ? body.delayMs : undefined,
      signal: controller.signal,
      onResult: pushProgress,
    });

    job.finished = true;
    job.cancelled = cancelled;
    const stats: FinalBatchStats = {
      ...aggregateStats(results, job.total, 'final'),
      phase: 'final',
      cancelled,
      durationMs: Date.now() - job.startedAt,
      policyHash,
      binding,
    };
    send(cancelled ? {type: 'cancelled', stats, results, policyHash} : {type: 'done', stats, results, policyHash});
    res.end();
    // 保留任务一小段时间，供取消接口幂等返回；10 分钟后清理
    setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000).unref?.();
  });

  app.post('/api/simulate/:jobId/cancel', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({error: 'job_not_found'});
    if (!job.finished) {
      job.cancelled = true;
      job.controller.abort();
    }
    res.json({jobId: job.id, cancelled: job.cancelled, finished: job.finished});
  });

  app.get('/api/simulate/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({error: 'job_not_found'});
    res.json({
      jobId: job.id,
      finished: job.finished,
      cancelled: job.cancelled,
      binding: job.binding,
      policyHash: job.policyHash,
      completed: job.results.length,
      total: job.total,
    });
  });

  // 兼容既有测试 / 旧前端的文档接口
  app.get('/api/documents', (_req, res) =>
    res.json(samples.map(({content, ...row}) => row)),
  );
  app.get('/api/documents/:id', (req, res) => {
    const row = samples.find((s) => s.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });
  app.put('/api/documents/:id', (req, res) => {
    const row = samples.find((s) => s.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (Number(req.body.revision) !== row.revision) {
      return res.status(409).json({error: 'revision_conflict', current: row});
    }
    row.content = String(req.body.content ?? '');
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json(row);
  });
  app.post('/api/documents/:id/analyze', async (req, res) => {
    const row = samples.find((s) => s.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    await new Promise((resolve) => setTimeout(resolve, row.id === 'alpha' ? 100 : 20));
    res.json({
      id: row.id,
      revision: row.revision,
      lines: String(req.body.content ?? row.content).split(/\r?\n/).length,
      diagnostics: [],
    });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
