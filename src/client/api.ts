import type {
  Compilation,
  SampleRow,
  SampleSimulation,
  SimEvent,
  StoredPolicy,
} from '../shared/types';

async function jsonOrThrow(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(body.message || body.error || `请求失败 ${response.status}`), {
      status: response.status,
      body,
    });
  }
  return body;
}

export const api = {
  async bootstrap() {
    return jsonOrThrow(await fetch('/api/bootstrap'));
  },
  async getPolicy(): Promise<StoredPolicy> {
    return jsonOrThrow(await fetch('/api/policy'));
  },
  async compile(draft: import('../shared/types').PolicyDraft): Promise<Compilation> {
    return jsonOrThrow(
      await fetch('/api/policy/compile', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(draft),
      }),
    );
  },
  async savePolicy(
    draft: import('../shared/types').PolicyDraft,
    revision: number,
  ): Promise<StoredPolicy> {
    return jsonOrThrow(
      await fetch('/api/policy', {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({...draft, revision}),
      }),
    );
  },
  async listSamples(): Promise<Pick<SampleRow, 'id' | 'name' | 'revision' | 'updatedAt'>[]> {
    return jsonOrThrow(await fetch('/api/samples'));
  },
  async getSample(id: string): Promise<SampleRow> {
    return jsonOrThrow(await fetch(`/api/samples/${id}`));
  },
  async saveSample(id: string, content: string, revision: number): Promise<SampleRow> {
    return jsonOrThrow(
      await fetch(`/api/samples/${id}`, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({content, revision}),
      }),
    );
  },
};

export interface StreamHandlers {
  onStart?: (event: Extract<SimEvent, {type: 'start'}>) => void;
  onProgress?: (event: Extract<SimEvent, {type: 'progress'}>) => void;
  onDone?: (event: Extract<SimEvent, {type: 'done'}>) => void;
  onCancelled?: (event: Extract<SimEvent, {type: 'cancelled'}>) => void;
  /** 服务端在 NDJSON 之前以 4xx/5xx JSON 返回错误（如编译失败） */
  onFatalError?: (error: {status: number; body: any}) => void;
}

/**
 * 启动批量模拟并流式消费 NDJSON。
 * 返回的 cancel() 会：中断本地读取（服务端 req close 即中止任务），并尽力调用取消接口。
 */
export async function startSimulation(
  payload: {
    draft: import('../shared/types').PolicyDraft;
    sampleIds?: string[];
    detectorFailures?: Record<string, {code: 'detector_unavailable' | 'detector_error'; message: string}>;
    delayMs?: number;
  },
  handlers: StreamHandlers,
): Promise<{cancel: () => void; jobId: string | null}> {
  const controller = new AbortController();
  let cancelledViaApi = false;

  async function callCancelEndpoint(jobId: string | null): Promise<void> {
    if (!jobId || cancelledViaApi) return;
    cancelledViaApi = true;
    await fetch(`/api/simulate/${jobId}/cancel`, {method: 'POST'}).catch(() => undefined);
  }

  try {
    const response = await fetch('/api/simulate', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      handlers.onFatalError?.({status: response.status, body});
      return {cancel: () => undefined, jobId: null};
    }
    const jobId = response.headers.get('x-sim-job-id');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as SimEvent;
        switch (event.type) {
          case 'start':
            handlers.onStart?.(event);
            break;
          case 'progress':
            handlers.onProgress?.(event);
            break;
          case 'done':
            handlers.onDone?.(event);
            break;
          case 'cancelled':
            handlers.onCancelled?.(event);
            break;
        }
      }
    }
    return {
      jobId,
      cancel: () => {
        controller.abort();
        void callCancelEndpoint(jobId);
      },
    };
  } catch (error) {
    // 主动取消导致的读取中断由 cancelled 事件体现；这里吞掉 abort 噪音
    if ((error as Error).name !== 'AbortError') {
      handlers.onFatalError?.({status: 0, body: {error: 'network_error', message: (error as Error).message}});
    }
    return {
      jobId: null,
      cancel: () => {
        controller.abort();
      },
    };
  }
}

export function resultSampleMap(results: SampleSimulation[]): Map<string, SampleSimulation> {
  return new Map(results.map((r) => [r.sampleId, r]));
}
