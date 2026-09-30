import { describe, expect, test } from 'vitest';
import {
  CROSS_FIELD_RULES,
  campaignSchema,
  defaultCampaign,
  type Campaign,
} from '@/schema/campaign';
import { toDecoderSchema, toJsonSchema } from '@/schema/jsonSchema';
import { setAt } from '@/lib/path';
import { changedPrefixes, diff } from './diff';
import {
  runCopilot,
  type ChatMessage,
  type CopilotEvent,
  type ModelClient,
  type RunCopilotOptions,
} from './loop';
import { createScriptedModel, SUGGESTED_PROMPTS } from './scripted';

const promptSchema = toJsonSchema(campaignSchema);
const base = {
  schema: campaignSchema,
  promptSchema,
  decoderSchema: toDecoderSchema(promptSchema),
  crossFieldRules: CROSS_FIELD_RULES,
  current: defaultCampaign,
  request: 'test',
  today: '2026-09-30',
} satisfies Omit<RunCopilotOptions<Campaign>, 'model'>;

/** Returns each response in order and records what the model was sent. */
function sequenceModel(responses: readonly string[]) {
  const calls: ChatMessage[][] = [];
  const model: ModelClient = {
    label: 'test',
    async generate({ messages, onText }) {
      calls.push([...messages]);
      const text = responses[calls.length - 1];
      if (text === undefined) throw new Error('out of responses');
      onText?.(text);
      return text;
    },
  };
  return { model, calls };
}

const json = (c: unknown) => JSON.stringify(c);

describe('diff', () => {
  test('reports leaf changes and treats primitive arrays as one value', () => {
    const after = setAt(
      setAt(defaultCampaign, ['targeting', 'devices'], ['mobile']),
      ['offer', 'code'],
      'SAVE15',
    );
    expect(diff(defaultCampaign, after)).toEqual([
      { path: 'targeting.devices', before: ['desktop', 'mobile'], after: ['mobile'] },
      { path: 'offer.code', before: 'WELCOME10', after: 'SAVE15' },
    ]);
  });

  test('recurses into arrays of objects by index', () => {
    const withRule = setAt(
      defaultCampaign,
      ['audienceRules'],
      [{ attribute: 'referrer', operator: 'contains', value: 'x' }],
    );
    const edited = setAt(withRule, ['audienceRules', 0, 'value'], 'y');
    expect(diff(withRule, edited)).toEqual([
      { path: 'audienceRules.0.value', before: 'x', after: 'y' },
    ]);
    expect(diff(defaultCampaign, withRule)).toHaveLength(1);
  });

  test('changedPrefixes includes parent groups', () => {
    expect([...changedPrefixes([{ path: 'offer.code', before: 1, after: 2 }])]).toEqual([
      'offer',
      'offer.code',
    ]);
  });
});

describe('runCopilot', () => {
  test('applies a valid config on the first attempt', async () => {
    const next = setAt(defaultCampaign, ['frequency'], 'once_per_day');
    const { model } = sequenceModel([json(next)]);
    const result = await runCopilot({ ...base, model });
    expect(result).toMatchObject({
      status: 'applied',
      attempts: 1,
      changes: [{ path: 'frequency' }],
    });
  });

  test('sends validation errors back and applies the correction', async () => {
    const invalid = setAt(defaultCampaign, ['targeting', 'devices'], ['mobile']);
    const fixed = setAt(invalid, ['trigger', 'type'], 'time_on_page');
    const { model, calls } = sequenceModel([json(invalid), json(fixed)]);
    const events: CopilotEvent<Campaign>[] = [];

    const result = await runCopilot({ ...base, model, onEvent: (e) => events.push(e) });

    expect(result.status).toBe('applied');
    expect(events.filter((e) => e.kind !== 'text').map((e) => e.kind)).toEqual([
      'attempt',
      'rejected',
      'attempt',
      'applied',
    ]);
    const feedback = calls[1]?.at(-1);
    expect(feedback?.role).toBe('user');
    expect(feedback?.content).toContain('trigger.type: Exit intent needs a desktop cursor');
    expect(calls[1]?.at(-2)).toEqual({ role: 'assistant', content: json(invalid) });
  });

  test('treats unparseable output as a validation failure', async () => {
    const { model, calls } = sequenceModel([
      '{"name": "cut o',
      json(setAt(defaultCampaign, ['name'], 'Fixed')),
    ]);
    const result = await runCopilot({ ...base, model });
    expect(result.status).toBe('applied');
    expect(calls[1]?.at(-1)?.content).toContain('not valid JSON');
  });

  test('reports unchanged when the model returns the same config', async () => {
    const { model } = sequenceModel([json(defaultCampaign)]);
    expect(await runCopilot({ ...base, model })).toEqual({ status: 'unchanged', attempts: 1 });
  });

  test('gives up after the attempt budget with the last errors', async () => {
    const invalid = json(setAt(defaultCampaign, ['offer', 'code'], 'bad code'));
    const { model } = sequenceModel([invalid, invalid]);
    const result = await runCopilot({ ...base, model, maxAttempts: 2 });
    expect(result).toMatchObject({ status: 'failed', attempts: 2 });
    expect(result.status === 'failed' && result.errors[0]).toContain('offer.code');
  });

  test('stops when aborted', async () => {
    const controller = new AbortController();
    const model: ModelClient = {
      label: 'abort',
      async generate() {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      },
    };
    expect(await runCopilot({ ...base, model, signal: controller.signal })).toEqual({
      status: 'aborted',
      attempts: 1,
    });
  });

  test("puts today's date, the rules and the schema in the prompt", async () => {
    const { model, calls } = sequenceModel([json(defaultCampaign)]);
    await runCopilot({ ...base, model });
    const system = calls[0]?.[0]?.content ?? '';
    expect(system).toContain('2026-09-30');
    expect(system).toContain(CROSS_FIELD_RULES[1] ?? 'missing');
    expect(system).toContain('"Popup campaign"');
  });
});

describe('scripted model', () => {
  for (const prompt of SUGGESTED_PROMPTS) {
    test(`suggested prompt ends valid: ${prompt.text}`, async () => {
      const result = await runCopilot({
        ...base,
        request: prompt.text,
        model: createScriptedModel(10_000, 0),
      });
      expect(result.status).toBe('applied');
      expect(result.attempts).toBe(prompt.script.length);
    });
  }

  test('refuses free-form requests', async () => {
    await expect(
      runCopilot({ ...base, request: 'anything else', model: createScriptedModel(10_000, 0) }),
    ).rejects.toThrow('suggested prompts');
  });
});
