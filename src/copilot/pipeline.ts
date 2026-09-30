import { toDecoderSchema, toJsonSchema } from '@/schema/jsonSchema';
import {
  intentSchema,
  planSchema,
  replyTextSchema,
  type Call,
  type Intent,
  type Plan,
  type TodoState,
} from '@/todo/schema';
import { applyCall } from '@/todo/tools';
import {
  checkCalls,
  formatIssues,
  generateChecked,
  type AssistantEvent,
  type ChatMessage,
  type ModelClient,
} from './loop';
import {
  ASSISTANT_NAME,
  contextBlock,
  EXAMPLE_STATE,
  jsonSchema,
  HISTORY_TURNS,
  ON_TOPIC,
  REQUEST_PREFIX,
  toolsBlock,
  userMessage,
  type PastTurn,
} from './prompt';

/*
 * The model does what it's reliable at; code does what must be exact.
 *   1. The planner (the model, constrained to `planSchema`) labels the request
 *      and maps it to tool calls. It never talks to the user.
 *   2. The calls are validated and applied, all or nothing.
 *   3. The reply depends on the intent:
 *        change    -> the facts of what happened, written by code
 *        off_topic -> a fixed decline
 *        question  -> the model answers in its own words (the only prose it writes)
 */

const planDecoderSchema = toDecoderSchema(toJsonSchema(planSchema));

export const DECLINE =
  'Sorry, I can only help with your todo list: adding, renaming, completing, deleting and filtering todos. What would you like to do?';

function plannerSystem(): string {
  return [
    'You are the planner inside a todo list app. You never talk to the user. Label the latest request and turn it into calls to the tools below, which are everything the app can do.',
    'Use ids from the todo context; never invent one. Every answer is checked; if a check fails you will be told why, so fix it and answer again.',
    '',
    '# Response',
    'Answer with JSON: {"intent": <intent>, "calls": [{"name": <tool name>, "arguments": <arguments object>}, ...]}.',
    '<intent_schema>',
    JSON.stringify(jsonSchema(intentSchema)),
    '</intent_schema>',
    '',
    toolsBlock(),
    '',
    contextBlock(),
  ].join('\n');
}

const PLAN_EXAMPLES: readonly { request: string; plan: Plan }[] = [
  {
    request: 'add apples and pears, and tick off pay rent',
    plan: {
      intent: 'change',
      calls: [
        { name: 'add_todo', arguments: { title: 'Apples' } },
        { name: 'add_todo', arguments: { title: 'Pears' } },
        { name: 'toggle_todo', arguments: { id: 't1' } },
      ],
    },
  },
  { request: 'how many are left?', plan: { intent: 'question', calls: [] } },
  {
    request: "clear the done ones and show me what's left",
    plan: {
      intent: 'change',
      calls: [
        { name: 'clear_completed', arguments: {} },
        { name: 'set_filter', arguments: { filter: 'active' } },
      ],
    },
  },
  { request: 'tell me a joke', plan: { intent: 'off_topic', calls: [] } },
  { request: 'thanks!', plan: { intent: 'question', calls: [] } },
];

/**
 * Earlier changes as facts, so a follow-up like "change that back" can see
 * what a todo was called before. Calls alone only carry the new values.
 */
function recentChanges(history: readonly PastTurn[]): string[] {
  const lines = history.slice(-HISTORY_TURNS).flatMap((turn) => turn.changes);
  return lines.length === 0 ? [] : ['Recent changes, oldest first:', ...lines.map((l) => `- ${l}`)];
}

function plannerMessages(
  state: TodoState,
  history: readonly PastTurn[],
  request: string,
): ChatMessage[] {
  return [
    { role: 'system', content: plannerSystem() },
    ...PLAN_EXAMPLES.flatMap((e): ChatMessage[] => [
      { role: 'user', content: userMessage(EXAMPLE_STATE, e.request) },
      { role: 'assistant', content: JSON.stringify(e.plan) },
    ]),
    ...history.slice(-HISTORY_TURNS).flatMap((turn): ChatMessage[] => [
      { role: 'user', content: `${REQUEST_PREFIX}${turn.request}` },
      {
        role: 'assistant',
        content: JSON.stringify({ intent: turn.intent, calls: turn.calls }),
      },
    ]),
    { role: 'user', content: userMessage(state, request, recentChanges(history)) },
  ];
}

const FILTER_WORDS = {
  all: 'all todos',
  active: 'only active todos',
  completed: 'only completed todos',
} as const;

/**
 * What a batch of calls did, as plain facts with titles resolved against the
 * list before each call. This is the reply for a change: written by code, so
 * it is always true. The calls are already validated.
 */
export function describeCalls(before: TodoState, calls: readonly Call[]): string[] {
  const lines: string[] = [];
  let state = before;
  for (const call of calls) {
    const title = (id: string) => `'${state.todos.find((t) => t.id === id)?.title ?? id}'`;
    switch (call.name) {
      case 'add_todo':
        lines.push(`Added '${call.arguments.title.trim()}'.`);
        break;
      case 'edit_todo':
        lines.push(`Renamed ${title(call.arguments.id)} to '${call.arguments.title.trim()}'.`);
        break;
      case 'toggle_todo': {
        const done = state.todos.find((t) => t.id === call.arguments.id)?.completed;
        lines.push(`Marked ${title(call.arguments.id)} as ${done ? 'active' : 'done'}.`);
        break;
      }
      case 'toggle_all':
        lines.push(`Marked every todo as ${call.arguments.completed ? 'done' : 'active'}.`);
        break;
      case 'delete_todo':
        lines.push(`Deleted ${title(call.arguments.id)}.`);
        break;
      case 'clear_completed': {
        const cleared = state.todos.filter((t) => t.completed).map((t) => `'${t.title}'`);
        lines.push(
          cleared.length === 0
            ? 'There were no completed todos to clear.'
            : `Cleared ${cleared.join(', ')}.`,
        );
        break;
      }
      case 'set_filter':
        lines.push(`Now showing ${FILTER_WORDS[call.arguments.filter]}.`);
        break;
    }
    const applied = applyCall(state, call);
    if (applied.ok) state = applied.state;
  }
  return lines;
}

/**
 * The list summarised as facts. Small models miscount and misfile todos when
 * reading the JSON themselves; given these lines they only have to copy.
 */
function counts(state: TodoState): string {
  const group = (completed: boolean) => {
    const titles = state.todos.filter((t) => t.completed === completed).map((t) => `'${t.title}'`);
    return `${titles.length} ${completed ? 'completed' : 'active'}${titles.length > 0 ? ` (${titles.join(', ')})` : ''}`;
  };
  return `Counts: ${group(false)}; ${group(true)}; showing ${FILTER_WORDS[state.filter]}.`;
}

function answererSystem(): string {
  return [
    `You are ${ASSISTANT_NAME}, the friendly support assistant built into this todo list app. The app can do what the tools below do, and nothing else; you describe them, you don't call them.`,
    'Answer the question about the list or the app in one or two short, plain sentences, using the todo context and counts. For a greeting or thanks, reply briefly. Nothing on the list changes in these turns, so never say you changed anything.',
    ...ON_TOPIC,
    '',
    toolsBlock(),
    '',
    contextBlock(),
  ].join('\n');
}

const answerTurn = (state: TodoState, request: string) =>
  userMessage(state, request, [counts(state)]);

const ANSWER_EXAMPLES: readonly ChatMessage[] = [
  { role: 'user', content: answerTurn(EXAMPLE_STATE, 'how many are left?') },
  { role: 'assistant', content: "You have 1 todo left: 'Pay rent'." },
  { role: 'user', content: answerTurn(EXAMPLE_STATE, 'what can you do?') },
  {
    role: 'assistant',
    content:
      'I can add, rename, complete and delete todos, clear the completed ones, and filter the list. What would you like to do?',
  },
];

function answererMessages(
  state: TodoState,
  history: readonly PastTurn[],
  request: string,
): ChatMessage[] {
  return [
    { role: 'system', content: answererSystem() },
    ...ANSWER_EXAMPLES,
    ...history.slice(-HISTORY_TURNS).flatMap((turn): ChatMessage[] => [
      { role: 'user', content: `${REQUEST_PREFIX}${turn.request}` },
      { role: 'assistant', content: turn.reply },
    ]),
    { role: 'user', content: answerTurn(state, request) },
  ];
}

export type TurnResult =
  | {
      status: 'done';
      intent: Intent;
      reply: string;
      calls: readonly Call[];
      /** The calls as plain facts; empty unless the intent was a change. */
      changes: readonly string[];
      state: TodoState;
      attempts: number;
    }
  | { status: 'failed'; errors: string[]; attempts: number }
  | { status: 'aborted'; attempts: number };

export interface RunPipelineOptions {
  state: TodoState;
  history: readonly PastTurn[];
  request: string;
  model: ModelClient;
  maxAttempts?: number;
  signal?: AbortSignal;
  /** Planner attempts and rejections. */
  onPlanEvent?: (event: AssistantEvent) => void;
  /** An answer as it streams, as plain text. */
  onReplyText?: (text: string) => void;
}

export async function runPipeline(options: RunPipelineOptions): Promise<TurnResult> {
  const { state, history, request, model, maxAttempts, signal } = options;

  const plan = await generateChecked({
    model,
    messages: plannerMessages(state, history, request),
    decoderSchema: planDecoderSchema,
    check: checkCalls(planSchema, state),
    maxAttempts,
    signal,
    onEvent: options.onPlanEvent,
  });
  if (plan.status !== 'ok') return plan;

  const { intent, calls } = plan.value;
  const done = (reply: string, changes: readonly string[] = []): TurnResult => ({
    status: 'done',
    intent,
    reply,
    calls,
    changes,
    state: plan.value.state,
    attempts: plan.attempts,
  });

  if (intent === 'change') {
    const changes = describeCalls(state, calls);
    return done(changes.join(' '), changes);
  }
  if (intent === 'off_topic') return done(DECLINE);

  const answer = await generateChecked({
    model,
    messages: answererMessages(state, history, request),
    check: (text) => {
      const result = replyTextSchema.safeParse(text);
      return result.success
        ? { ok: true, value: result.data }
        : { ok: false, errors: formatIssues(result.error.issues) };
    },
    maxAttempts,
    signal,
    onEvent: (e) => {
      if (e.kind === 'text') options.onReplyText?.(e.text);
    },
  });
  if (answer.status !== 'ok') return answer;
  return done(answer.value);
}
