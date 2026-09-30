import type { z } from 'zod';
import { toDecoderSchema, toJsonSchema, type JsonSchemaNode } from '@/schema/jsonSchema';
import { replySchema, type Call, type TodoState } from '@/todo/schema';
import { applyCalls } from '@/todo/tools';
import { buildMessages } from './prompt';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateRequest {
  messages: readonly ChatMessage[];
  /** Constrains decoding. The model can only emit JSON of this shape. */
  decoderSchema: JsonSchemaNode;
  /** Called with the full text generated so far. */
  onText?: (text: string) => void;
  signal?: AbortSignal;
}

export interface ModelClient {
  readonly label: string;
  generate(request: GenerateRequest): Promise<string>;
}

/** The reply-and-calls shape as JSON Schema, and the structural subset that constrains decoding. */
export const replyJsonSchema = toJsonSchema(replySchema);
export const decoderSchema = toDecoderSchema(replyJsonSchema);

export type AssistantEvent =
  | { kind: 'attempt'; attempt: number }
  | { kind: 'text'; attempt: number; text: string }
  | { kind: 'rejected'; attempt: number; errors: string[]; calls: readonly Call[] };

export type AssistantResult =
  | {
      status: 'done';
      reply: string;
      calls: readonly Call[];
      state: TodoState;
      attempts: number;
      text: string;
    }
  | { status: 'failed'; errors: string[]; attempts: number }
  | { status: 'aborted'; attempts: number };

export interface RunAssistantOptions {
  state: TodoState;
  /** Earlier requests and accepted replies; trimmed to the last few by the prompt builder. */
  history: readonly ChatMessage[];
  request: string;
  model: ModelClient;
  maxAttempts?: number;
  signal?: AbortSignal;
  onEvent?: (event: AssistantEvent) => void;
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map(
    (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
  );
}

/**
 * One chat turn. The model answers under a constrained decoder with a reply
 * and a list of tool calls. Zod checks the shape, then the calls are applied
 * to a copy of the list, all or nothing, which catches what the decoder can't
 * (an id that doesn't exist, an empty title). Failures go back to the model
 * until it passes or the attempt budget runs out. Nothing changes the real
 * list unless the whole turn is valid; the caller commits `state`.
 */
export async function runAssistant(options: RunAssistantOptions): Promise<AssistantResult> {
  const { state, model, signal, onEvent } = options;
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }

  const messages = buildMessages(state, options.history, options.request);
  let lastErrors: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) return { status: 'aborted', attempts: attempt - 1 };
    onEvent?.({ kind: 'attempt', attempt });

    let text: string;
    try {
      text = await model.generate({
        messages,
        decoderSchema,
        onText: (t) => onEvent?.({ kind: 'text', attempt, text: t }),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error: unknown) {
      if (isAbort(error, signal)) return { status: 'aborted', attempts: attempt };
      throw error;
    }
    if (signal?.aborted) return { status: 'aborted', attempts: attempt };

    let calls: readonly Call[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
      lastErrors = ['(root): the response was not valid JSON; it may have been cut off'];
    }

    if (parsed !== undefined) {
      const shape = replySchema.safeParse(parsed);
      if (shape.success) {
        calls = shape.data.calls;
        const applied = applyCalls(state, calls);
        if (applied.ok) {
          return {
            status: 'done',
            reply: shape.data.reply,
            calls,
            state: applied.state,
            attempts: attempt,
            text,
          };
        }
        lastErrors = applied.errors;
      } else {
        lastErrors = formatIssues(shape.error.issues);
      }
    }

    onEvent?.({ kind: 'rejected', attempt, errors: lastErrors, calls });
    messages.push(
      { role: 'assistant', content: text },
      {
        role: 'user',
        content:
          'That answer failed validation, so nothing was changed:\n' +
          lastErrors.map((e) => `- ${e}`).join('\n') +
          '\nFix these problems and answer again with the complete reply and calls.',
      },
    );
  }

  return { status: 'failed', errors: lastErrors, attempts: maxAttempts };
}
