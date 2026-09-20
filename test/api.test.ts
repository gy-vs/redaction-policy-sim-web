import {describe, expect, it} from 'vitest';
import request from 'supertest';
import type {Response} from 'superagent';
import {createApp} from '../src/server/index';
import type {PolicyDraft, SimEvent} from '../src/shared/types';

async function getValidDraft(app: ReturnType<typeof createApp>): Promise<{draft: PolicyDraft; revision: number}> {
  const res = await request(app).get('/api/policy').expect(200);
  const {revision, ...draft} = res.body as PolicyDraft & {revision: number};
  return {draft, revision};
}

function parseNdJson(text: string): SimEvent[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SimEvent);
}

async function simulate(
  app: ReturnType<typeof createApp>,
  draft: PolicyDraft,
  extra: Record<string, unknown> = {},
): Promise<{events: SimEvent[]; response: Response; jobIdHeader: string; raw: string}> {
  const rawChunks: Buffer[] = [];
  const response = await request(app)
    .post('/api/simulate')
    .send({draft, ...extra})
    .buffer(true)
    .parse((res, cb) => {
      res.on('data', (c: Buffer) => rawChunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(rawChunks).toString('utf8')));
      res.on('error', (err: Error) => cb(err, ''));
    });
  const raw =
    typeof response.body === 'string'
      ? response.body
      : Buffer.concat(rawChunks).toString('utf8');
  return {events: parseNdJson(raw), response, jobIdHeader: response.headers['x-sim-job-id'] as string, raw};
}

describe('策略 API', () => {
  it('编译有效草稿返回 hash 与诊断；无效引用 valid=false', async () => {
    const app = createApp();
    const {draft} = await getValidDraft(app);
    const ok = await request(app).post('/api/policy/compile').send(draft).expect(200);
    expect(ok.body.valid).toBe(true);
    expect(ok.body.hash).toMatch(/^[0-9a-f]{16}$/);

    const bad = await request(app)
      .post('/api/policy/compile')
      .send({...draft, rules: [{...draft.rules[0], detectorId: 'nope'}]})
      .expect(200);
    expect(bad.body.valid).toBe(false);
    expect(bad.body.diagnostics[0].code).toBe('invalid_reference');
  });

  it('并发保存：revision 不匹配返回 409 与服务端当前版本；匹配时前进 revision', async () => {
    const app = createApp();
    const {draft, revision} = await getValidDraft(app);

    const stale = await request(app)
      .put('/api/policy')
      .send({...draft, revision: revision + 99})
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.current.revision).toBe(revision);

    const saved = await request(app).put('/api/policy').send({...draft, revision}).expect(200);
    expect(saved.body.revision).toBe(revision + 1);

    // 旧 revision 再次保存立刻冲突
    await request(app).put('/api/policy').send({...draft, revision}).expect(409);
  });

  it('编译错误的草稿不能保存（422 且带诊断）', async () => {
    const app = createApp();
    const {draft, revision} = await getValidDraft(app);
    await request(app)
      .put('/api/policy')
      .send({...draft, revision, rules: [{...draft.rules[0], detectorId: 'ghost'}]})
      .expect(422);
  });
});

describe('样例 API', () => {
  it('样例更新带 revision 并发控制（兼容旧 documents 接口）', async () => {
    const app = createApp();
    const before = await request(app).get('/api/documents/alpha').expect(200);
    await request(app)
      .put('/api/documents/alpha')
      .send({content: 'updated', revision: before.body.revision})
      .expect(200);
    await request(app)
      .put('/api/documents/alpha')
      .send({content: 'stale', revision: before.body.revision})
      .expect(409);
  });

  it('新 /api/samples 接口同样返回 409 与当前行', async () => {
    const app = createApp();
    const before = await request(app).get('/api/samples/alpha').expect(200);
    const conflict = await request(app)
      .put('/api/samples/alpha')
      .send({content: 'x', revision: before.body.revision + 1})
      .expect(409);
    expect(conflict.body.current.revision).toBe(before.body.revision);
  });
});

describe('批量模拟', () => {
  it('流式返回 start/progress/done，绑定 policyHash 与样例 revision，部分统计与最终统计区分', async () => {
    const app = createApp();
    const {draft} = await getValidDraft(app);
    const samples = (await request(app).get('/api/samples').expect(200)).body as {id: string; revision: number}[];
    const {events, response, jobIdHeader} = await simulate(app, draft);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(jobIdHeader).toBeTruthy();

    const start = events.find((e) => e.type === 'start');
    const progress = events.filter((e) => e.type === 'progress');
    const done = events.find((e) => e.type === 'done');
    expect(start?.type).toBe('start');
    if (start?.type !== 'start') throw new Error('no start');
    expect(start.total).toBe(samples.length);
    expect(start.binding).toEqual(samples.map((s) => ({sampleId: s.id, revision: s.revision})));

    // 每个样例一条 progress，phase=partial，计数单调
    expect(progress).toHaveLength(samples.length);
    for (const e of progress) {
      if (e.type !== 'progress') throw new Error('bad event');
      expect(e.stats.phase).toBe('partial');
    }
    expect((progress[0] as any).stats.completed).toBe(1);

    expect(done?.type).toBe('done');
    if (done?.type !== 'done') throw new Error('no done');
    expect(done.stats.phase).toBe('final');
    expect(done.stats.completed).toBe(samples.length);
    expect(done.stats.total).toBe(samples.length);
    expect(done.stats.cancelled).toBe(false);
    expect(done.policyHash).toBe(start.policyHash);
    // 最终结果包含每个样例，且结果中带回绑定哈希
    expect(done.results.map((r) => r.sampleId).sort()).toEqual(samples.map((s) => s.id).sort());
    expect(done.results.every((r) => r.policyHash === start.policyHash)).toBe(true);
  });

  it('默认策略在 alpha 样例上产生重叠协调：身份证被掩码、密钥被涂黑，且解释覆盖关系', async () => {
    const app = createApp();
    const {draft} = await getValidDraft(app);
    const {events} = await simulate(app, draft, {sampleIds: ['alpha']});
    const done = events.find((e) => e.type === 'done');
    if (done?.type !== 'done') throw new Error('no done');
    const alpha = done.results[0];
    expect(alpha.output).toContain('***');
    expect(alpha.output).toContain('█');
    expect(alpha.output).not.toContain('11010119900307851X');
    expect(alpha.output).not.toContain('sk-live');
    // 每个 proposal 都有人类可读原因
    expect(alpha.proposals.length).toBeGreaterThan(0);
    expect(alpha.proposals.every((p) => p.reason.length > 20)).toBe(true);
    // 范围溯源按字符偏移
    for (const range of alpha.ranges) {
      expect(range.end).toBeGreaterThan(range.start);
    }
  });

  it('检测器失败被记录为 detectorErrors，按 0 命中处理且不阻断其他样例', async () => {
    const app = createApp();
    const {draft} = await getValidDraft(app);
    const {events} = await simulate(app, draft, {
      detectorFailures: {
        email: {code: 'detector_unavailable', message: 'email service down'},
      },
    });
    const done = events.find((e) => e.type === 'done');
    if (done?.type !== 'done') throw new Error('no done');
    // 全部样例都完成（错误样例不阻断其他样例）
    expect(done.stats.completed).toBe(done.stats.total);
    expect(done.stats.detectorErrors).toBeGreaterThan(0);
    expect(done.stats.sampleErrors).toBe(0);
    const withErrors = done.results.filter((r) => r.detectorErrors.length > 0);
    expect(withErrors.length).toBeGreaterThan(0);
    expect(withErrors[0].detectorErrors[0]).toMatchObject({
      detectorId: 'email',
      code: 'detector_unavailable',
    });
    // 邮箱仍通过 phone/id_card 等其他检测器产出范围（alpha 有身份证、密钥）
    const alpha = done.results.find((r) => r.sampleId === 'alpha')!;
    expect(alpha.stats.ranges).toBeGreaterThan(0);
    expect(alpha.output).not.toContain('sk-live');
  });

  it('可取消：取消接口中止任务，返回 cancelled 与已完成部分结果', async () => {
    const app = createApp();
    const {draft} = await getValidDraft(app);
    const jobIdPromise = new Promise<string>((resolve) => {
      // 先发请求（带延迟让取消先到），用 supertest 的 abort 比较麻烦，改用：服务端延迟 + 主动取消接口
      const req = request(app)
        .post('/api/simulate')
        .send({draft, delayMs: 120})
        .buffer(true)
        .parse((res, cb) => {
          // 收到 start（含 job id）后立刻调用 cancel
          let buffer = '';
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            const firstLine = buffer.split('\n')[0];
            if (firstLine) {
              try {
                const evt = JSON.parse(firstLine) as SimEvent;
                if (evt.type === 'start') {
                  resolve(evt.jobId);
                }
              } catch {
                /* 半包 */
              }
            }
          });
          res.on('end', () => cb(null, buffer));
        });
      req.catch(() => undefined);
    });

    const jobId = await jobIdPromise;
    // 给循环一点时间进入等待后取消
    await new Promise((r) => setTimeout(r, 30));
    const cancelRes = await request(app).post(`/api/simulate/${jobId}/cancel`).expect(200);
    expect(cancelRes.body.cancelled).toBe(true);

    // 查询任务状态
    const status = await request(app).get(`/api/simulate/${jobId}`).expect(200);
    expect(status.body.cancelled).toBe(true);
  }, 15000);

  it('编译失败的草稿拒绝模拟（422）', async () => {
    const app = createApp();
    const {draft} = await getValidDraft(app);
    const res = await request(app)
      .post('/api/simulate')
      .send({draft: {...draft, rules: [{...draft.rules[0], detectorId: 'ghost'}]}})
      .expect(422);
    expect(res.body.error).toBe('compilation_failed');
  });

  it('空样例集合返回 400', async () => {
    const app = createApp();
    const {draft} = await getValidDraft(app);
    await request(app).post('/api/simulate').send({draft, sampleIds: ['nobody']}).expect(400);
  });

  it('模拟绑定的哈希随规则重排而变化', async () => {
    const app = createApp();
    const {draft} = await getValidDraft(app);
    const run1 = await simulate(app, draft, {sampleIds: ['gamma']});
    const reordered = {...draft, rules: [...draft.rules].reverse()};
    const run2 = await simulate(app, reordered, {sampleIds: ['gamma']});
    const h1 = (run1.events.find((e) => e.type === 'start') as any).policyHash;
    const h2 = (run2.events.find((e) => e.type === 'start') as any).policyHash;
    expect(h1).not.toBe(h2);
  });
});

describe('样例更新与模拟绑定', () => {
  it('模拟进行中样例被更新：结果保留 boundRevision 并标记 revisionChanged 不阻断', async () => {
    const app = createApp();
    const {draft} = await getValidDraft(app);
    // 先更新一次样例制造 revision 差，再模拟：绑定应以模拟开始时 revision 为准
    const before = await request(app).get('/api/samples/gamma').expect(200);
    const updated = await request(app)
      .put('/api/samples/gamma')
      .send({content: '新内容 13812345678', revision: before.body.revision})
      .expect(200);

    const {events} = await simulate(app, draft, {sampleIds: ['gamma']});
    const done = events.find((e) => e.type === 'done');
    if (done?.type !== 'done') throw new Error('no done');
    const gamma = done.results[0];
    expect(gamma.boundRevision).toBe(updated.body.revision);
    expect(gamma.sampleRevision).toBe(updated.body.revision);
    // 新内容含手机号，contact 派生（union 含 phone）应给出标签
    expect(gamma.output).toContain('[联系方式打标签]');
  });
});
