import type { Campaign } from '@/schema/campaign';
import type { ChatMessage, GenerateRequest, ModelClient } from './loop';

type Responder = (current: Campaign, attempt: number) => unknown;

export interface SuggestedPrompt {
  text: string;
  /** What the scripted model returns on each attempt, used only without WebGPU. */
  script: readonly Responder[];
}

export const SUGGESTED_PROMPTS: readonly SuggestedPrompt[] = [
  {
    text: 'Run this on mobile only, and bump the discount to 15% with the code SAVE15.',
    script: [
      // First attempt keeps the exit-intent trigger, which the cross-field rule rejects.
      (c) => ({
        ...c,
        targeting: { ...c.targeting, devices: ['mobile'] },
        offer: {
          ...c.offer,
          discountPercent: 15,
          code: 'SAVE15',
          headline: 'Get 15% off your first order',
        },
      }),
      (c) => ({
        ...c,
        trigger: { ...c.trigger, type: 'time_on_page', delaySeconds: 8 },
        targeting: { ...c.targeting, devices: ['mobile'] },
        offer: {
          ...c.offer,
          discountPercent: 15,
          code: 'SAVE15',
          headline: 'Get 15% off your first order',
        },
      }),
    ],
  },
  {
    text: 'Only show it to visitors from Instagram with more than $50 in their cart.',
    script: [
      (c) => ({
        ...c,
        audienceRules: [
          { attribute: 'utm_source', operator: 'equals', value: 'instagram' },
          { attribute: 'cart_value', operator: 'greater_than', value: '$50' },
        ],
      }),
      (c) => ({
        ...c,
        audienceRules: [
          { attribute: 'utm_source', operator: 'equals', value: 'instagram' },
          { attribute: 'cart_value', operator: 'greater_than', value: '50' },
        ],
      }),
    ],
  },
  {
    text: 'Never show it on checkout or account pages, and run it for the first two weeks of November.',
    script: [
      (c) => ({
        ...c,
        targeting: { ...c.targeting, excludedPaths: ['/checkout', '/account'] },
        schedule: { start: '2026-11-01', end: '2026-11-14' },
      }),
    ],
  },
];

const CURRENT_MARKER = 'Current configuration:\n';
const REQUEST_MARKER = '\n\nRequest: ';

function parseFirstUserMessage(messages: readonly ChatMessage[]): {
  current: Campaign;
  request: string;
} {
  const first = messages.find((m) => m.role === 'user');
  if (first === undefined) throw new Error('Scripted model: no user message');
  const start = first.content.indexOf(CURRENT_MARKER);
  const split = first.content.indexOf(REQUEST_MARKER);
  if (start === -1 || split === -1) throw new Error('Scripted model: unexpected prompt format');
  return {
    current: JSON.parse(first.content.slice(start + CURRENT_MARKER.length, split)) as Campaign,
    request: first.content.slice(split + REQUEST_MARKER.length).trim(),
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/**
 * A stand-in for machines without WebGPU. It replays scripted responses for
 * the suggested prompts, streamed at a readable pace, through the same
 * validation loop as the real model.
 */
export function createScriptedModel(charsPerTick = 24, tickMs = 16): ModelClient {
  return {
    label: 'Scripted (no WebGPU)',
    async generate({ messages, onText, signal }: GenerateRequest): Promise<string> {
      const { current, request } = parseFirstUserMessage(messages);
      const prompt = SUGGESTED_PROMPTS.find((p) => p.text === request);
      if (prompt === undefined) {
        throw new Error(
          'Scripted mode only supports the suggested prompts. Load a model to ask anything.',
        );
      }
      const attempt = messages.filter((m) => m.role === 'assistant').length;
      const responder = prompt.script[Math.min(attempt, prompt.script.length - 1)];
      if (responder === undefined) throw new Error('Scripted model: empty script');

      const text = JSON.stringify(responder(current, attempt), null, 2);
      for (let i = charsPerTick; i < text.length + charsPerTick; i += charsPerTick) {
        await sleep(tickMs, signal);
        onText?.(text.slice(0, i));
      }
      return text;
    },
  };
}
