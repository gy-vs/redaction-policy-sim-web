import {afterAll, describe, expect, it} from 'vitest';
import request from 'supertest';
import type {AddressInfo} from 'node:net';
import {createApp} from '../src/server/index';
import {createStore, defaultPolicy} from '../src/server/store';
import {compilePolicy, hashPolicy} from '../src/shared/compile';
import {coordinate, simulateSample} from '../src/shared/simulate';
import type {Policy, SimEvent} from '../src/shared/domain';

const policy = (mutate: (p: Policy) => void = () => {}): Policy => {
  const p = defaultPolicy();
  mutate(p);
  return p;
};

/** 收集一次完整模拟的 NDJSON 事件流 */
async function collectEvents(app: ReturnType<typeof createApp>, draft: Policy): Promise<SimEvent[]> {
  const res = await request(app)
    .post('/api/simulate')
    .send({policy: draft})
    .buffer(true)
    .parse((r, cb) => {
      let text = '';
      r.on('data', (c: Buffer) => (text += c.toString()));
      r.on('end', () => cb(null, text));
    });
  expect(res.status).toBe(200);
  return (res.body as string)
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as SimEvent);
}

describe('策略编译校验', () => {
  it('检出无效引用', () => {
    const compiled = compilePolicy(
      policy(p => {
        p.rules[0].base = 'r-not-exist';
      }),
    );
    expect(compiled.issues.some(i => i.code === 'invalid_reference' && i.ruleId === 'r-id-card')).toBe(true);
  });

  it('检出循环派生', () => {
    const compiled = compilePolicy(
      policy(p => {
        p.rules[0].base = 'r-phone';
        p.rules[1].base = 'r-id-card';
      }),
    );
    const circular = compiled.issues.filter(i => i.code === 'circular_derivation');
    expect(circular.map(i => i.ruleId).sort()).toEqual(['r-id-card', 'r-phone']);
  });

  it('检出永远不可达规则（祖先阈值 > 1）', () => {
    const compiled = compilePolicy(
      policy(p => {
        p.rules[0].threshold = 1.5;
        p.rules[1].base = 'r-id-card';
      }),
    );
    expect(compiled.issues.some(i => i.code === 'unreachable_rule' && i.ruleId === 'r-phone')).toBe(true);
  });

  it('检出越界阈值与缺失替换文案', () => {
    const compiled = compilePolicy(
      policy(p => {
        p.rules[0].threshold = -0.1;
        p.rules[1].strategy = 'redact';
        p.rules[1].replacement = '  ';
      }),
    );
    expect(compiled.issues.some(i => i.code === 'invalid_threshold')).toBe(true);
    expect(compiled.issues.some(i => i.code === 'missing_replacement')).toBe(true);
  });

  it('拒绝保存非法策略（422），接受合法策略', async () => {
    const app = createApp(createStore());
    const bad = policy(p => {
      p.rules[0].base = 'r-not-exist';
    });
    await request(app).put('/api/policy').send({policy: bad, expectedRevision: 1}).expect(422);
    const ok = await request(app)
      .put('/api/policy')
      .send({policy: policy(), expectedRevision: 1})
      .expect(200);
    expect(ok.body.revision.revision).toBe(2);
    expect(ok.body.revision.hash).toBe(hashPolicy(policy()));
  });
});

describe('规则重排与统一协调', () => {
  const overlapText = '紧急联系人方式：13812345678@139.com 或 13912345678。';

  const twoRulePolicy = (emailFirst: boolean): Policy => {
    const email = {
      id: 'r-email',
      name: '邮箱',
      detector: 'email' as const,
      threshold: 0.5,
      strategy: 'redact' as const,
      base: null,
      replacement: '[邮箱]',
    };
    const phone = {
      id: 'r-phone',
      name: '手机',
      detector: 'phone' as const,
      threshold: 0.5,
      strategy: 'mask' as const,
      base: null,
      replacement: '',
    };
    return {rules: emailFirst ? [email, phone] : [phone, email]};
  };

  it('同一起点的重叠候选按规则顺序决出胜者，败者进入被覆盖列表', () => {
    const emailFirst = compilePolicy(twoRulePolicy(true));
    const result = simulateSample(emailFirst, {id: 't', revision: 1, content: overlapText});
    const first = result.decisions.find(d => d.text.includes('@'));
    expect(first?.winner.ruleId).toBe('r-email');
    expect(first?.overridden.map(o => o.ruleId)).toContain('r-phone');
    expect(first?.overridden[0].order).toBeGreaterThan(first!.winner.order);

    const phoneFirst = compilePolicy(twoRulePolicy(false));
    const result2 = simulateSample(phoneFirst, {id: 't', revision: 1, content: overlapText});
    const first2 = result2.decisions.find(d => d.text.includes('@') || d.text === '13812345678');
    expect(first2?.winner.ruleId).toBe('r-phone');
    expect(first2?.overridden.map(o => o.ruleId)).toContain('r-email');
  });

  it('重排改变草稿哈希（用于绑定与过期判定）', () => {
    expect(hashPolicy(twoRulePolicy(true))).not.toBe(hashPolicy(twoRulePolicy(false)));
  });

  it('协调结果与检测器产出顺序无关（确定性）', () => {
    const compiled = compilePolicy(twoRulePolicy(true));
    const findingsA = simulateSample(compiled, {id: 't', revision: 1, content: overlapText});
    const findingsB = simulateSample(compiled, {id: 't', revision: 1, content: overlapText});
    expect(findingsA.decisions).toEqual(findingsB.decisions);
    // 独立验证 coordinate 的排序键
    const d = coordinate(compiled, [
      {detector: 'phone', start: 7, end: 18, text: '13812345678', confidence: 0.9},
      {detector: 'email', start: 7, end: 22, text: '13812345678@139.com', confidence: 0.8},
    ]);
    expect(d[0].winner.ruleId).toBe('r-email');
    expect(d[0].overridden[0].ruleId).toBe('r-phone');
  });
});

describe('阈值边界', () => {
  const emailPolicy = (threshold: number): Policy => ({
    rules: [
      {
        id: 'r-email',
        name: '邮箱',
        detector: 'email',
        threshold,
        strategy: 'redact',
        base: null,
        replacement: '[邮箱]',
      },
    ],
  });
  const text = '联系 invoice@corp-example.cn 谢谢';

  it('置信度等于阈值（0.8）时命中', () => {
    const result = simulateSample(compilePolicy(emailPolicy(0.8)), {id: 't', revision: 1, content: text});
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].winner.confidence).toBe(0.8);
  });

  it('阈值高出 0.01（0.81）时不命中', () => {
    const result = simulateSample(compilePolicy(emailPolicy(0.81)), {id: 't', revision: 1, content: text});
    expect(result.decisions).toHaveLength(0);
  });
});

describe('批量模拟：流式、失败隔离、统计区分', () => {
  it('检测器失败只标记对应样例，其余样例正常完成', async () => {
    const app = createApp(createStore());
    const events = await collectEvents(app, policy());
    const samples = events.filter(e => e.type === 'sample');
    const broken = samples.find(e => e.result.sampleId === 'broken');
    expect(broken?.result.status).toBe('error');
    expect(broken?.result.error).toContain('bank-card');
    const okSamples = samples.filter(e => e.result.status === 'ok');
    expect(okSamples.length).toBe(3);
    const done = events.find(e => e.type === 'done');
    expect(done?.summary.failed).toBe(1);
    expect(done?.summary.completed).toBe(4);
  });

  it('进行中事件标记 partial=true，终态标记 partial=false，且绑定草稿哈希与样例 revision', async () => {
    const app = createApp(createStore());
    const draft = policy();
    const events = await collectEvents(app, draft);
    const started = events.find(e => e.type === 'started');
    expect(started?.policyHash).toBe(hashPolicy(draft));
    expect(started?.sampleRevision).toBe(1);
    for (const e of events.filter(e => e.type === 'sample')) {
      expect(e.summary.partial).toBe(true);
      expect(e.summary.policyHash).toBe(hashPolicy(draft));
    }
    const done = events.find(e => e.type === 'done');
    expect(done?.summary.partial).toBe(false);
    expect(done?.cancelled).toBe(false);
  });

  it('客户端中止后模拟取消，不再产生后续样例事件', async () => {
    const app = createApp(createStore());
    const server = app.listen(0);
    afterAll(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/simulate`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({policy: policy()}),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: SimEvent[] = [];
    let buffer = '';
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        let i: number;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (line) events.push(JSON.parse(line));
        }
        if (events.some(e => e.type === 'sample')) controller.abort();
      }
    } catch {
      // AbortError 属于预期路径
    }
    expect(events.some(e => e.type === 'started')).toBe(true);
    expect(events.some(e => e.type === 'sample')).toBe(true);
    // 取消发生在首个样例之后，不应收到完整 4 个样例，也不应收到 done
    expect(events.filter(e => e.type === 'sample').length).toBeLessThan(4);
    expect(events.some(e => e.type === 'done')).toBe(false);
  });
});

describe('样例更新与绑定', () => {
  it('更新样例提升 revision；旧 revision 更新返回 409', async () => {
    const app = createApp(createStore());
    const updated = await request(app)
      .put('/api/samples/basic')
      .send({content: '新内容 13812345678', expectedRevision: 1})
      .expect(200);
    expect(updated.body.revision).toBe(2);
    await request(app)
      .put('/api/samples/basic')
      .send({content: '再次', expectedRevision: 1})
      .expect(409);
    // 新模拟绑定新的样例 revision
    const events = await collectEvents(app, policy());
    const started = events.find(e => e.type === 'started');
    expect(started?.sampleRevision).toBe(2);
  });
});

describe('并发保存', () => {
  it('同一 revision 的并发保存只有一个成功，另一个收到 409 与当前状态', async () => {
    const app = createApp(createStore());
    const before = await request(app).get('/api/policy').expect(200);
    const rev = before.body.revision;
    const a = policy(p => {
      p.rules[0].name = '并发写者 A';
    });
    const b = policy(p => {
      p.rules[0].name = '并发写者 B';
    });
    const [ra, rb] = await Promise.all([
      request(app).put('/api/policy').send({policy: a, expectedRevision: rev}),
      request(app).put('/api/policy').send({policy: b, expectedRevision: rev}),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    const conflict = [ra, rb].find(r => r.status === 409)!;
    expect(conflict.body.conflict.current.revision).toBe(rev + 1);
    // 冲突方用新 revision 重试可以成功
    const retry = await request(app)
      .put('/api/policy')
      .send({policy: b, expectedRevision: rev + 1})
      .expect(200);
    expect(retry.body.revision.revision).toBe(rev + 2);
  });
});
