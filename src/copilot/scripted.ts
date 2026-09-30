import { contextSchema, type Call, type Plan, type Todo } from '@/todo/schema';
import type { ChatMessage, GenerateRequest, ModelClient } from './loop';
import { REQUEST_PREFIX, STATE_HEADER } from './prompt';

type Planner = (todos: readonly Todo[]) => Plan;

interface SuggestedPrompt {
  text: string;
  /** What the scripted planner returns on each attempt. */
  plan: readonly Planner[];
  /** What the scripted answerer says, for a question. */
  answer?: string;
}

export const SUGGESTED_PROMPTS: readonly SuggestedPrompt[] = [
  {
    text: 'Add eggs and bread, and mark buy milk as done.',
    plan: [
      // First attempt guesses an id instead of copying it; the tool rejects it.
      () => ({
        intent: 'change_list',
        calls: [
          { name: 'add_todo', arguments: { title: 'Eggs' } },
          { name: 'add_todo', arguments: { title: 'Bread' } },
          { name: 'mark_todo', arguments: { id: 'buy-milk', completed: true } },
        ],
      }),
      (todos) => {
        const milk = todos.find((t) => t.title.toLowerCase() === 'buy milk');
        const calls: Call[] = [
          { name: 'add_todo', arguments: { title: 'Eggs' } },
          { name: 'add_todo', arguments: { title: 'Bread' } },
        ];
        if (milk !== undefined) {
          calls.push({ name: 'mark_todo', arguments: { id: milk.id, completed: true } });
        }
        return { intent: 'change_list', calls };
      },
    ],
  },
  {
    text: "Clear the finished ones and show me what's left.",
    plan: [
      // Annotated: without it, `{}` and `{ filter }` widen into an invalid union.
      (): Plan => ({
        intent: 'change_list',
        calls: [
          { name: 'clear_completed', arguments: {} },
          { name: 'set_filter', arguments: { filter: 'active' } },
        ],
      }),
    ],
  },
  {
    text: 'What can you do?',
    plan: [() => ({ intent: 'about_list', calls: [] })],
    answer:
      'I can add, rename, complete and delete todos, clear the completed ones, and filter the list. What would you like to do?',
  },
  {
    text: 'Write me a poem about cats.',
    plan: [() => ({ intent: 'off_topic', calls: [] })],
  },
];

const STATE_MARKER = `${STATE_HEADER}\n`;
const REQUEST_MARKER = `\n${REQUEST_PREFIX}`;

/** Reads the context and the request back out of the latest turn's user message. */
function parseTurn(messages: readonly ChatMessage[]): {
  todos: readonly Todo[];
  request: string;
  attempt: number;
} {
  let index = messages.length - 1;
  while (index >= 0 && !messages[index]?.content.startsWith(STATE_MARKER)) index--;
  const turn = messages[index];
  if (turn === undefined) throw new Error('Scripted model: unexpected prompt format');
  const { content } = turn;
  // The context is one JSON line, right after the marker.
  const contextEnd = content.indexOf('\n', STATE_MARKER.length);
  return {
    todos: contextSchema.parse(JSON.parse(content.slice(STATE_MARKER.length, contextEnd))).todos,
    request: content.slice(content.lastIndexOf(REQUEST_MARKER) + REQUEST_MARKER.length).trim(),
    attempt: messages.slice(index).filter((m) => m.role === 'assistant').length,
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
 * A stand-in for machines without WebGPU. It replays scripted answers for the
 * suggested prompts, streamed at a readable pace, through the same pipeline
 * and validation as the real model. A request with a decoder schema is the
 * planner; one without is the question answerer.
 */
export function createScriptedModel(charsPerTick = 6, tickMs = 16): ModelClient {
  return {
    async generate({ messages, decoderSchema, onText, signal }: GenerateRequest): Promise<string> {
      const { todos, request, attempt } = parseTurn(messages);
      const prompt = SUGGESTED_PROMPTS.find((p) => p.text === request);
      let text: string;
      if (decoderSchema !== undefined) {
        const planner = prompt?.plan[Math.min(attempt, prompt.plan.length - 1)];
        text = JSON.stringify(planner?.(todos) ?? { intent: 'about_list', calls: [] }, null, 2);
      } else {
        text =
          prompt?.answer ??
          'Scripted mode only knows the suggested prompts. Load a model to ask me anything.';
      }
      for (let i = charsPerTick; i < text.length + charsPerTick; i += charsPerTick) {
        await sleep(tickMs, signal);
        onText?.(text.slice(0, i));
      }
      return text;
    },
  };
}
