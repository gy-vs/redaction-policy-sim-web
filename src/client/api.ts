import type {CompiledPolicy, Policy, PolicyRevision, Sample, SimEvent} from '../shared/domain';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export const api = {
  async bootstrap(): Promise<{policy: PolicyRevision; samples: Sample[]}> {
    return json(await fetch('/api/bootstrap'));
  },
  async compile(policy: Policy): Promise<CompiledPolicy> {
    return json(
      await fetch('/api/policy/compile', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(policy),
      }),
    );
  },
  async savePolicy(policy: Policy, expectedRevision: number): Promise<Response> {
    return fetch('/api/policy', {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({policy, expectedRevision}),
    });
  },
  async saveSample(id: string, content: string, expectedRevision: number): Promise<Response> {
    return fetch(`/api/samples/${id}`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content, expectedRevision}),
    });
  },
};

/** 读取 NDJSON 流，逐事件回调；外部用 AbortController 取消。 */
export async function streamSimulation(
  policy: Policy,
  onEvent: (event: SimEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/simulate', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({policy}),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`simulate failed: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onEvent(JSON.parse(line) as SimEvent);
    }
  }
}
