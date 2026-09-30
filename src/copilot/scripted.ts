import { TOOLS, type AssistantReply, type Todo } from '@/todo/schema';
import type { ChatMessage, GenerateRequest, ModelClient } from './loop';
import { REQUEST_PREFIX, STATE_HEADER } from './prompt';

type Responder = (todos: readonly Todo[]) => AssistantReply;

interface SuggestedPrompt {
  text: string;
  /** What the scripted model returns on each attempt, used only without WebGPU. */
  script: readonly Responder[];
}

export const SUGGESTED_PROMPTS: readonly SuggestedPrompt[] = [
  {
    text: 'Add eggs and bread, and mark buy milk as done.',
    script: [
      // First attempt guesses an id instead of copying it; the tool rejects it.
      () => ({
        reply: "Added eggs and bread, and marked 'Buy milk' as done.",
        calls: [
          { tool: 'add_todo', args: { title: 'Eggs' } },
          { tool: 'add_todo', args: { title: 'Bread' } },
          { tool: 'toggle_todo', args: { id: 'buy-milk' } },
        ],
      }),
      (todos) => {
        const milk = todos.find((t) => t.title.toLowerCase() === 'buy milk');
        // toggle_todo flips, so only call it when there is something to mark done.
        const toggle = milk !== undefined && !milk.completed;
        let reply: string;
        if (milk === undefined) {
          reply =
            "Added eggs and bread. I couldn't find 'Buy milk' in your list, so I left that part.";
        } else if (milk.completed) {
          reply = "Added eggs and bread. 'Buy milk' was already done.";
        } else {
          reply = "Added eggs and bread, and marked 'Buy milk' as done.";
        }
        return {
          reply,
          calls: [
            { tool: 'add_todo', args: { title: 'Eggs' } },
            { tool: 'add_todo', args: { title: 'Bread' } },
            ...(toggle ? [{ tool: 'toggle_todo' as const, args: { id: milk.id } }] : []),
          ],
        };
      },
    ],
  },
  {
    text: "Clear the finished ones and show me what's left.",
    script: [
      (): AssistantReply => ({
        reply: 'Cleared your completed todos and switched the view to active ones.',
        calls: [
          { tool: 'clear_completed', args: {} },
          { tool: 'set_filter', args: { filter: 'active' } },
        ],
      }),
    ],
  },
  {
    text: 'What can you do?',
    script: [
      () => ({
        reply: `I can do anything the app's own controls can: ${TOOLS.map((t) => t.name.replace('_', ' ')).join(', ')}. Just tell me what you need.`,
        calls: [],
      }),
    ],
  },
  {
    text: 'Write me a poem about cats.',
    script: [
      () => ({
        reply:
          "Sorry, I can only help with your todo list. I could add 'Write a poem about cats' as a todo, if you like.",
        calls: [],
      }),
    ],
  },
];

const STATE_MARKER = `${STATE_HEADER}\n`;
const REQUEST_MARKER = `\n${REQUEST_PREFIX}`;

/** Reads the list and the request back out of the latest turn's user message. */
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
  // The list is one JSON line, right after the marker.
  const listEnd = content.indexOf('\n', STATE_MARKER.length);
  return {
    todos: JSON.parse(content.slice(STATE_MARKER.length, listEnd)) as readonly Todo[],
    request: content.slice(content.indexOf(REQUEST_MARKER) + REQUEST_MARKER.length).trim(),
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
 * A stand-in for machines without WebGPU. It replays scripted responses for
 * the suggested prompts, streamed at a readable pace, through the same
 * validation loop as the real model.
 */
export function createScriptedModel(charsPerTick = 6, tickMs = 16): ModelClient {
  return {
    label: 'Scripted (no WebGPU)',
    async generate({ messages, onText, signal }: GenerateRequest): Promise<string> {
      const { todos, request, attempt } = parseTurn(messages);
      const prompt = SUGGESTED_PROMPTS.find((p) => p.text === request);
      const responder = prompt?.script[Math.min(attempt, prompt.script.length - 1)];
      const response: AssistantReply = responder?.(todos) ?? {
        reply: 'Scripted mode only knows the suggested prompts. Load a model to ask me anything.',
        calls: [],
      };

      // Same key order the real model is constrained to: calls, then reply.
      const text = JSON.stringify({ calls: response.calls, reply: response.reply }, null, 2);
      for (let i = charsPerTick; i < text.length + charsPerTick; i += charsPerTick) {
        await sleep(tickMs, signal);
        onText?.(text.slice(0, i));
      }
      return text;
    },
  };
}
