import { expect, test } from 'vitest';
import { isSamplerGlitch } from './webllm';

test('recognises the upstream sampler glitch, and nothing else', () => {
  // The exact message WebLLM 0.2.85 throws (mlc-ai/web-llm#807).
  expect(isSamplerGlitch(new Error('Grammar matcher rejected the newly sampled token.'))).toBe(
    true,
  );
  expect(isSamplerGlitch(new Error('WebGPU device was lost'))).toBe(false);
  expect(isSamplerGlitch('Grammar matcher rejected')).toBe(false);
});
