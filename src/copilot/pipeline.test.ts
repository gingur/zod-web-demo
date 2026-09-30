import { describe, expect, test } from 'vitest';
import { toDecoderSchema, toJsonSchema } from '@/schema/jsonSchema';
import { initialState, planSchema, TOOLS, type Plan } from '@/todo/schema';
import { ResampleError, type AssistantEvent, type GenerateRequest, type ModelClient } from './loop';
import { DECLINE, describeCalls, runPipeline, type RunPipelineOptions } from './pipeline';
import { contextBlock, toolsBlock, userMessage, type PastTurn } from './prompt';
import { createScriptedModel, SUGGESTED_PROMPTS } from './scripted';

const base = {
  state: initialState,
  history: [],
  request: 'test',
} satisfies Omit<RunPipelineOptions, 'model'>;

/** Returns each response in order and records every request the model got. */
function sequenceModel(responses: readonly (string | Error)[]) {
  const requests: GenerateRequest[] = [];
  const model: ModelClient = {
    async generate(request) {
      requests.push({ ...request, messages: [...request.messages] });
      const next = responses[requests.length - 1];
      if (next === undefined) throw new Error('out of responses');
      if (next instanceof Error) throw next;
      request.onText?.(next);
      return next;
    },
  };
  return { model, requests };
}

const plan = (p: Plan) => JSON.stringify(p);

describe('runPipeline', () => {
  test('a change is applied and the reply is the facts, written by code', async () => {
    const { model, requests } = sequenceModel([
      plan({
        intent: 'change',
        calls: [
          { name: 'add_todo', arguments: { title: 'Eggs' } },
          { name: 'toggle_todo', arguments: { id: 't1' } },
        ],
      }),
    ]);
    const result = await runPipeline({ ...base, model });
    expect(result).toMatchObject({
      status: 'done',
      intent: 'change',
      reply: "Added 'Eggs'. Marked 'Buy milk' as done.",
      changes: ["Added 'Eggs'.", "Marked 'Buy milk' as done."],
    });
    expect(result.status === 'done' && result.state.todos.at(-1)?.title).toBe('Eggs');
    // One generation: the model never narrates a change.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.decoderSchema).toBeDefined();
  });

  test('off-topic requests get the fixed decline, and nothing else runs', async () => {
    const { model, requests } = sequenceModel([plan({ intent: 'off_topic', calls: [] })]);
    const result = await runPipeline({ ...base, model });
    expect(result).toMatchObject({ status: 'done', reply: DECLINE, calls: [] });
    expect(requests).toHaveLength(1);
  });

  test('a question is answered in free text by a second, unconstrained pass', async () => {
    const texts: string[] = [];
    const { model, requests } = sequenceModel([
      plan({ intent: 'question', calls: [] }),
      'You have 2 todos left.',
    ]);
    const result = await runPipeline({ ...base, model, onReplyText: (t) => texts.push(t) });
    expect(result).toMatchObject({
      status: 'done',
      intent: 'question',
      reply: 'You have 2 todos left.',
    });
    expect(result.status === 'done' && result.state).toBe(initialState);
    expect(requests[1]?.decoderSchema).toBeUndefined();
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      "Counts: 2 active ('Buy milk', 'Call mom'); 1 completed ('Walk the dog')",
    );
    expect(texts.at(-1)).toBe('You have 2 todos left.');
  });

  test('an intent that disagrees with its calls is sent back', async () => {
    const { model, requests } = sequenceModel([
      plan({
        intent: 'question',
        calls: [{ name: 'toggle_all', arguments: { completed: false } }],
      }),
      plan({ intent: 'question', calls: [] }),
      'Here is your list.',
    ]);
    const result = await runPipeline({ ...base, model });
    expect(result.status).toBe('done');
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      'A question request changes nothing; leave calls empty.',
    );
  });

  test('a failing call is sent back, and nothing is applied until the retry passes', async () => {
    const bad = plan({
      intent: 'change',
      calls: [
        { name: 'add_todo', arguments: { title: 'Eggs' } },
        { name: 'toggle_todo', arguments: { id: 'milk' } },
      ],
    });
    const good = plan({
      intent: 'change',
      calls: [{ name: 'toggle_todo', arguments: { id: 't1' } }],
    });
    const { model, requests } = sequenceModel([bad, good]);
    const events: AssistantEvent[] = [];
    const result = await runPipeline({ ...base, model, onPlanEvent: (e) => events.push(e) });

    expect(result.status).toBe('done');
    expect(events.filter((e) => e.kind !== 'text').map((e) => e.kind)).toEqual([
      'attempt',
      'rejected',
      'attempt',
    ]);
    const feedback = requests[1]?.messages.at(-1)?.content ?? '';
    expect(feedback).toContain('calls.1 (toggle_todo): There is no todo with id "milk"');
    expect(requests[1]?.messages.at(-2)).toEqual({ role: 'assistant', content: bad });
    // The rejected batch's add_todo never happened.
    expect(result.status === 'done' && result.state.todos.map((t) => t.title)).not.toContain(
      'Eggs',
    );
  });

  test('unparseable output is a validation failure, not a crash', async () => {
    const { model, requests } = sequenceModel([
      '{"intent": "cha',
      plan({ intent: 'off_topic', calls: [] }),
    ]);
    expect((await runPipeline({ ...base, model })).status).toBe('done');
    expect(requests[1]?.messages.at(-1)?.content).toContain('not valid JSON');
  });

  test('gives up after the attempt budget with the last errors', async () => {
    const bad = plan({
      intent: 'change',
      calls: [{ name: 'delete_todo', arguments: { id: 'nope' } }],
    });
    const { model } = sequenceModel([bad, bad]);
    const result = await runPipeline({ ...base, model, maxAttempts: 2 });
    expect(result).toMatchObject({ status: 'failed', attempts: 2 });
    expect(result.status === 'failed' && result.errors[0]).toContain('"nope"');
  });

  test('a failed draw is re-sampled without blaming the model', async () => {
    const events: AssistantEvent[] = [];
    const { model, requests } = sequenceModel([
      new ResampleError('sampler glitch'),
      plan({ intent: 'off_topic', calls: [] }),
    ]);
    const result = await runPipeline({ ...base, model, onPlanEvent: (e) => events.push(e) });
    expect(result).toMatchObject({ status: 'done', attempts: 2 });
    // Same prompt both times: no feedback message, and nothing shown as a rejection.
    expect(requests[1]?.messages).toEqual(requests[0]?.messages);
    expect(events.some((e) => e.kind === 'rejected')).toBe(false);
  });

  test('stops when aborted', async () => {
    const controller = new AbortController();
    const model: ModelClient = {
      async generate() {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      },
    };
    expect(await runPipeline({ ...base, model, signal: controller.signal })).toEqual({
      status: 'aborted',
      attempts: 1,
    });
  });

  test('the planner sees recent changes as facts, so "change that back" knows the old title', async () => {
    const history: PastTurn[] = [
      {
        request: 'rename call mom',
        intent: 'change',
        calls: [{ name: 'edit_todo', arguments: { id: 't3', title: 'Call dad' } }],
        changes: ["Renamed 'Call mom' to 'Call dad'."],
        reply: "Renamed 'Call mom' to 'Call dad'.",
      },
    ];
    const { model, requests } = sequenceModel([plan({ intent: 'off_topic', calls: [] })]);
    await runPipeline({ ...base, model, history });
    expect(requests[0]?.messages.at(-1)?.content).toContain(
      "Recent changes, oldest first:\n- Renamed 'Call mom' to 'Call dad'.",
    );
  });
});

describe('describeCalls', () => {
  test('resolves titles against the list before each call', () => {
    expect(
      describeCalls(initialState, [
        { name: 'edit_todo', arguments: { id: 't3', title: 'Call dad' } },
        { name: 'delete_todo', arguments: { id: 't2' } },
        { name: 'toggle_todo', arguments: { id: 't1' } },
        { name: 'set_filter', arguments: { filter: 'active' } },
      ]),
    ).toEqual([
      "Renamed 'Call mom' to 'Call dad'.",
      "Deleted 'Walk the dog'.",
      "Marked 'Buy milk' as done.",
      'Now showing only active todos.',
    ]);
  });

  test('says which todos were cleared, or that there were none', () => {
    const clear = [{ name: 'clear_completed' as const, arguments: {} }];
    expect(describeCalls(initialState, clear)).toEqual(["Cleared 'Walk the dog'."]);
    const none = { ...initialState, todos: initialState.todos.filter((t) => !t.completed) };
    expect(describeCalls(none, clear)).toEqual(['There were no completed todos to clear.']);
  });
});

describe('what the model reads', () => {
  test('every tool argument is described in Zod, so the model knows what to send', () => {
    for (const tool of TOOLS) {
      for (const [field, schema] of Object.entries(tool.arguments.shape)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  test('tools reach the model as definitions generated from Zod, not as prose', () => {
    const definitions = toolsBlock()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { function: { name: string; parameters: unknown } });
    expect(definitions.map((d) => d.function.name)).toEqual(TOOLS.map((t) => t.name));
    const add = definitions.find((d) => d.function.name === 'add_todo');
    expect(JSON.stringify(add?.function.parameters)).toContain('The text of the one new todo');
  });

  test('the context is described once and validated on every turn', () => {
    expect(contextBlock()).toContain('Tools refer to a todo by this id.');
    expect(userMessage(initialState, 'hi')).toMatch(/^Todo context:\n\{"todos":\[.*"Buy milk"/);
    const broken = { ...initialState, todos: [{ id: 't1', title: '', completed: false }] };
    expect(() => userMessage(broken, 'hi')).toThrow();
  });

  test('the planner decoder keeps intent before calls, and the tool union as anyOf', () => {
    const decoder = toDecoderSchema(toJsonSchema(planSchema));
    expect(Object.keys(decoder.properties ?? {})).toEqual(['intent', 'calls']);
    const text = JSON.stringify(decoder);
    expect(text).toContain('"anyOf"');
    expect(text).toContain('"enum":["add_todo"]');
    expect(text).not.toContain('oneOf');
    expect(text).not.toContain('description');
  });
});

describe('scripted model', () => {
  for (const prompt of SUGGESTED_PROMPTS) {
    test(`suggested prompt ends with a reply: ${prompt.text}`, async () => {
      const result = await runPipeline({
        ...base,
        request: prompt.text,
        model: createScriptedModel(10_000, 0),
      });
      expect(result.status).toBe('done');
      expect(result.attempts).toBe(prompt.plan.length);
    });
  }

  test('the poem prompt is declined', async () => {
    const result = await runPipeline({
      ...base,
      request: 'Write me a poem about cats.',
      model: createScriptedModel(10_000, 0),
    });
    expect(result).toMatchObject({ status: 'done', reply: DECLINE });
  });

  test('never un-does a todo that is already done', async () => {
    const done = {
      ...initialState,
      todos: initialState.todos.map((t) => (t.id === 't1' ? { ...t, completed: true } : t)),
    };
    const result = await runPipeline({
      ...base,
      state: done,
      request: 'Add eggs and bread, and mark buy milk as done.',
      model: createScriptedModel(10_000, 0),
    });
    expect(result.status === 'done' && result.calls.map((c) => c.name)).toEqual([
      'add_todo',
      'add_todo',
    ]);
    expect(result.status === 'done' && result.state.todos[0]?.completed).toBe(true);
  });
});
