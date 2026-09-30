import type { InitProgressReport, MLCEngineInterface } from '@mlc-ai/web-llm';
import type { GenerateRequest, ModelClient } from './loop';

interface ModelOption {
  id: string;
  label: string;
  approxDownload: string;
}

/** Instruction-tuned models from WebLLM's prebuilt list, smallest first. */
export const MODEL_OPTIONS: readonly ModelOption[] = [
  {
    id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5 1.5B (fastest)',
    approxDownload: '~1 GB',
  },
  {
    id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5 3B (recommended)',
    approxDownload: '~2 GB',
  },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B', approxDownload: '~2 GB' },
  {
    id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5 7B (best, needs a strong GPU)',
    approxDownload: '~5 GB',
  },
];

export const DEFAULT_MODEL_ID = 'Qwen2.5-3B-Instruct-q4f16_1-MLC';

export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export interface LoadProgress {
  fraction: number;
  text: string;
}

/**
 * Loads a model into a Web Worker. Weights are cached by the browser after
 * the first download, so later loads are fast and work offline.
 */
export async function loadWebLLM(
  option: ModelOption,
  onProgress: (progress: LoadProgress) => void,
): Promise<ModelClient & { unload(): Promise<void> }> {
  if (!hasWebGPU())
    throw new Error("This browser doesn't support WebGPU. Use a recent Chrome or Edge.");

  const webllm = await import('@mlc-ai/web-llm');
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let engine: MLCEngineInterface;
  try {
    engine = await webllm.CreateWebWorkerMLCEngine(worker, option.id, {
      initProgressCallback: (report: InitProgressReport) =>
        onProgress({ fraction: report.progress, text: report.text }),
    });
  } catch (error: unknown) {
    worker.terminate();
    throw error;
  }

  return {
    async generate({ messages, decoderSchema, onText, signal }: GenerateRequest): Promise<string> {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const onAbort = () => engine.interruptGenerate();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const chunks = await engine.chat.completions.create({
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          temperature: 0.1,
          max_tokens: 1200,
          response_format: { type: 'json_object', schema: JSON.stringify(decoderSchema) },
        });
        let text = '';
        for await (const chunk of chunks) {
          text += chunk.choices[0]?.delta.content ?? '';
          onText?.(text);
        }
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return text;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
    async unload() {
      await engine.unload();
      worker.terminate();
    },
  };
}
