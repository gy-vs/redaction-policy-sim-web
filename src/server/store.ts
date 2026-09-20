import type {Policy, PolicyRevision, Sample} from '../shared/domain';
import {hashPolicy} from '../shared/compile';

export interface Store {
  getPolicy(): PolicyRevision;
  /** 基于 expectedRevision 的乐观并发控制；检查与提交之间无 await，单线程内原子完成 */
  savePolicy(expectedRevision: number, policy: Policy):
    | {ok: true; revision: PolicyRevision}
    | {ok: false; conflict: {current: PolicyRevision}};
  listSamples(): Sample[];
  getSample(id: string): Sample | undefined;
  updateSample(id: string, content: string, expectedRevision: number):
    | {ok: true; sample: Sample}
    | {ok: false; conflict: {current: Sample}}
    | {ok: false; notFound: true};
}

export function defaultPolicy(): Policy {
  return {
    rules: [
      {
        id: 'r-id-card',
        name: '身份证号整体替换',
        detector: 'id-card',
        threshold: 0.5,
        strategy: 'redact',
        base: null,
        replacement: '[身份证号]',
      },
      {
        id: 'r-phone',
        name: '手机号掩码',
        detector: 'phone',
        threshold: 0.8,
        strategy: 'mask',
        base: null,
        replacement: '',
      },
      {
        id: 'r-email',
        name: '邮箱哈希占位',
        detector: 'email',
        threshold: 0.8,
        strategy: 'hash',
        base: null,
        replacement: '',
      },
      {
        id: 'r-bank-card',
        name: '银行卡号掩码',
        detector: 'bank-card',
        threshold: 0.8,
        strategy: 'mask',
        base: null,
        replacement: '',
      },
    ],
  };
}

export function defaultSamples(): Sample[] {
  const now = new Date(0).toISOString();
  return [
    {
      id: 'basic',
      name: '基础样例：证件与手机',
      content:
        '客户 张三 的身份证号是 11010119900307777X，联系电话 13812345678，备用邮箱 zhang.san@example.com。',
      revision: 1,
      updatedAt: now,
    },
    {
      id: 'overlap',
      name: '重叠样例：邮箱与手机号',
      content: '紧急联系人方式：13812345678@139.com 或 13912345678。',
      revision: 1,
      updatedAt: now,
    },
    {
      id: 'threshold',
      name: '阈值边界样例：邮箱置信度 0.8',
      content: '发票抬头邮箱 invoice@corp-example.cn，置信度恰为 0.8，用于验证阈值边界。',
      revision: 1,
      updatedAt: now,
    },
    {
      id: 'broken',
      name: '故障样例：触发 bank-card 检测器崩溃',
      content: '这条样例包含 broken 标记，bank-card 检测器会在此抛错，其余样例不受影响。',
      revision: 1,
      updatedAt: now,
    },
  ];
}

export function createStore(): Store {
  let policyRevision: PolicyRevision = {
    revision: 1,
    hash: hashPolicy(defaultPolicy()),
    policy: defaultPolicy(),
    savedAt: new Date(0).toISOString(),
  };
  const samples = new Map<string, Sample>(defaultSamples().map(s => [s.id, s]));

  return {
    getPolicy: () => policyRevision,
    savePolicy(expectedRevision, policy) {
      if (expectedRevision !== policyRevision.revision) {
        return {ok: false, conflict: {current: policyRevision}};
      }
      policyRevision = {
        revision: policyRevision.revision + 1,
        hash: hashPolicy(policy),
        policy,
        savedAt: new Date().toISOString(),
      };
      return {ok: true, revision: policyRevision};
    },
    listSamples: () => [...samples.values()],
    getSample: id => samples.get(id),
    updateSample(id, content, expectedRevision) {
      const sample = samples.get(id);
      if (!sample) return {ok: false, notFound: true};
      if (expectedRevision !== sample.revision) {
        return {ok: false, conflict: {current: sample}};
      }
      const updated: Sample = {
        ...sample,
        content,
        revision: sample.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      samples.set(id, updated);
      return {ok: true, sample: updated};
    },
  };
}
