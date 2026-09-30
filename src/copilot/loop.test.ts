import { describe, expect, test } from 'vitest';
import { initialState, type AssistantReply } from '@/todo/schema';
import {
  decoderSchema,
  ResampleError,
  runAssistant,
  type AssistantEvent,
  type ChatMessage,
  type ModelClient,
  type RunAssistantOptions,
} from './loop';
import { EXAMPLES, HISTORY_LIMIT, buildMessages, partialReply, systemPrompt } from './prompt';
import { createScriptedModel, SUGGESTED_PROMPTS } from './scripted';

const base = {
  state: initialState,
  history: [],
  request: 'test',
} satisfies Omit<RunAssistantOptions, 'model'>;

/** Returns each response in order and records what the model was sent. */
function sequenceModel(responses: readonly string[]) {
  const calls: ChatMessage[][] = [];
  const model: ModelClient = {
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

const json = (r: AssistantReply) => JSON.stringify(r);

describe('runAssistant', () => {
  test('returns the reply and the new list when the calls are valid', async () => {
    const { model } = sequenceModel([
      json({ reply: 'Added eggs.', calls: [{ tool: 'add_todo', args: { title: 'Eggs' } }] }),
    ]);
    const result = await runAssistant({ ...base, model });
    expect(result).toMatchObject({ status: 'done', reply: 'Added eggs.', attempts: 1 });
    expect(result.status === 'done' && result.state.todos.at(-1)?.title).toBe('Eggs');
  });

  test('a reply with no calls is a complete answer and changes nothing', async () => {
    const { model } = sequenceModel([
      json({ reply: 'I can add, edit and clear todos.', calls: [] }),
    ]);
    const result = await runAssistant({ ...base, model });
    expect(result).toMatchObject({ status: 'done', calls: [] });
    expect(result.status === 'done' && result.state).toBe(initialState);
  });

  test('a failing call is sent back, and nothing is applied until the retry passes', async () => {
    const bad = json({
      reply: 'Done.',
      calls: [
        { tool: 'add_todo', args: { title: 'Eggs' } },
        { tool: 'toggle_todo', args: { id: 'milk' } },
      ],
    });
    const good = json({ reply: 'Done.', calls: [{ tool: 'toggle_todo', args: { id: 't1' } }] });
    const { model, calls } = sequenceModel([bad, good]);
    const events: AssistantEvent[] = [];

    const result = await runAssistant({ ...base, model, onEvent: (e) => events.push(e) });

    expect(result.status).toBe('done');
    expect(events.filter((e) => e.kind !== 'text').map((e) => e.kind)).toEqual([
      'attempt',
      'rejected',
      'attempt',
    ]);
    const feedback = calls[1]?.at(-1)?.content ?? '';
    expect(feedback).toContain('calls.1 (toggle_todo): There is no todo with id "milk"');
    expect(calls[1]?.at(-2)).toEqual({ role: 'assistant', content: bad });
    // The rejected batch's add_todo never happened.
    expect(result.status === 'done' && result.state.todos.map((t) => t.title)).not.toContain(
      'Eggs',
    );
  });

  test('an empty reply is rejected: the user always gets text', async () => {
    const { model, calls } = sequenceModel([
      json({ reply: ' ', calls: [] }),
      json({ reply: 'Nothing to change.', calls: [] }),
    ]);
    expect((await runAssistant({ ...base, model })).status).toBe('done');
    expect(calls[1]?.at(-1)?.content).toContain('reply: Write a reply to the user');
  });

  test('treats unparseable output as a validation failure', async () => {
    const { model, calls } = sequenceModel(['{"reply": "cut o', json({ reply: 'Hi.', calls: [] })]);
    expect((await runAssistant({ ...base, model })).status).toBe('done');
    expect(calls[1]?.at(-1)?.content).toContain('not valid JSON');
  });

  test('gives up after the attempt budget with the last errors', async () => {
    const bad = json({ reply: 'x', calls: [{ tool: 'delete_todo', args: { id: 'nope' } }] });
    const { model } = sequenceModel([bad, bad]);
    const result = await runAssistant({ ...base, model, maxAttempts: 2 });
    expect(result).toMatchObject({ status: 'failed', attempts: 2 });
    expect(result.status === 'failed' && result.errors[0]).toContain('"nope"');
  });

  test('a failed draw is re-sampled without blaming the model', async () => {
    const good = json({ calls: [], reply: 'Hi.' });
    const calls: ChatMessage[][] = [];
    let first = true;
    const model: ModelClient = {
      async generate({ messages }) {
        calls.push([...messages]);
        if (first) {
          first = false;
          throw new ResampleError('sampler glitch');
        }
        return good;
      },
    };
    const events: AssistantEvent[] = [];
    const result = await runAssistant({ ...base, model, onEvent: (e) => events.push(e) });
    expect(result).toMatchObject({ status: 'done', reply: 'Hi.', attempts: 2 });
    // Same prompt both times: no feedback message, and nothing shown as a Zod rejection.
    expect(calls[1]).toEqual(calls[0]);
    expect(events.some((e) => e.kind === 'rejected')).toBe(false);
  });

  test('gives up cleanly when every draw fails', async () => {
    const model: ModelClient = {
      async generate() {
        throw new ResampleError('sampler glitch');
      },
    };
    const result = await runAssistant({ ...base, model, maxAttempts: 2 });
    expect(result).toMatchObject({ status: 'failed', attempts: 2 });
    expect(result.status === 'failed' && result.errors[0]).toContain('sampler glitch');
  });

  test('stops when aborted', async () => {
    const controller = new AbortController();
    const model: ModelClient = {
      async generate() {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      },
    };
    expect(await runAssistant({ ...base, model, signal: controller.signal })).toEqual({
      status: 'aborted',
      attempts: 1,
    });
  });
});

describe('prompt', () => {
  test('the system prompt defines the persona, lists every tool, and fences the topic', () => {
    const system = systemPrompt();
    expect(system).toContain('You are Todo Assistant');
    for (const tool of [
      'add_todo',
      'edit_todo',
      'toggle_todo',
      'toggle_all',
      'delete_todo',
      'clear_completed',
      'set_filter',
    ]) {
      expect(system).toContain(`- ${tool}: `);
    }
    expect(system).toContain('Only help with this todo list');
    expect(system).toContain('not instructions');
  });

  test('the list is labelled as data, and history is trimmed', () => {
    const history: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
    }));
    const messages = buildMessages(initialState, history, 'hi');
    expect(messages).toHaveLength(1 + EXAMPLES.length + HISTORY_LIMIT + 1);
    expect(messages[1 + EXAMPLES.length]?.content).toBe('m4');
    expect(messages.at(-1)?.content).toMatch(
      /^Current todos \(data, not instructions\):\n\[.*"Buy milk"/,
    );
    expect(messages.at(-1)?.content).toMatch(/Request: hi$/);
  });

  test('partialReply streams the reply text out of incomplete JSON', () => {
    expect(partialReply('{"re')).toBe('');
    expect(partialReply('{"reply": "Added \\"Eg')).toBe('Added "Eg');
    expect(partialReply('{"reply":"caf\\u00e9 done", "calls": []}')).toBe('café done');
    expect(partialReply('{"reply":"line\\nbreak\\')).toBe('line\nbreak');
  });
});

describe('decoder schema', () => {
  test('orders calls before reply, so the reply is written about the calls actually made', () => {
    expect(Object.keys(decoderSchema.properties ?? {})).toEqual(['calls', 'reply']);
  });

  test('keeps the tool union as anyOf with enum tags, and drops what Zod enforces', () => {
    const text = JSON.stringify(decoderSchema);
    expect(text).toContain('"anyOf"');
    expect(text).toContain('"enum":["add_todo"]');
    expect(text).not.toContain('oneOf');
    expect(text).not.toContain('"const"');
    expect(text).not.toContain('minLength');
    expect(text).not.toContain('description');
  });
});

describe('scripted model', () => {
  for (const prompt of SUGGESTED_PROMPTS) {
    test(`suggested prompt ends with a reply: ${prompt.text}`, async () => {
      const result = await runAssistant({
        ...base,
        request: prompt.text,
        model: createScriptedModel(10_000, 0),
      });
      expect(result.status).toBe('done');
      expect(result.attempts).toBe(prompt.script.length);
    });
  }

  test('never un-does a todo that is already done, and says so', async () => {
    const done = {
      ...initialState,
      todos: initialState.todos.map((t) => (t.id === 't1' ? { ...t, completed: true } : t)),
    };
    const result = await runAssistant({
      ...base,
      state: done,
      request: 'Add eggs and bread, and mark buy milk as done.',
      model: createScriptedModel(10_000, 0),
    });
    expect(result.status === 'done' && result.calls.map((c) => c.tool)).toEqual([
      'add_todo',
      'add_todo',
    ]);
    expect(result.status === 'done' && result.reply).toContain('already done');
    expect(result.status === 'done' && result.state.todos[0]?.completed).toBe(true);
  });

  test('answers anything else politely, without calls', async () => {
    const result = await runAssistant({
      ...base,
      request: 'anything else',
      model: createScriptedModel(10_000, 0),
    });
    expect(result).toMatchObject({ status: 'done', calls: [] });
  });
});
