import type { z } from 'zod';
import type { JsonSchemaNode } from '@/schema/jsonSchema';
import type { Call, TodoState } from '@/todo/schema';
import { applyCalls } from '@/todo/tools';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateRequest {
  messages: readonly ChatMessage[];
  /** Constrains decoding to JSON of this shape. Omitted for free text. */
  decoderSchema?: JsonSchemaNode;
  /** Called with the full text generated so far. */
  onText?: (text: string) => void;
  signal?: AbortSignal;
}

export interface ModelClient {
  generate(request: GenerateRequest): Promise<string>;
}

/**
 * Thrown by a model client when a generation failed for a reason that is not
 * the model's answer, such that drawing again can succeed. The loop spends an
 * attempt on it but sends the model no feedback, since there is nothing to fix.
 */
export class ResampleError extends Error {
  override name = 'ResampleError';
}

export type AssistantEvent =
  | { kind: 'attempt'; attempt: number }
  | { kind: 'text'; attempt: number; text: string }
  | { kind: 'rejected'; attempt: number; errors: string[] };

type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] };
export type Check<T> = (text: string) => Checked<T>;

type Generated<T> =
  | { status: 'ok'; value: T; attempts: number }
  | { status: 'failed'; errors: string[]; attempts: number }
  | { status: 'aborted'; attempts: number };

export function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map(
    (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
  );
}

/** Parses JSON, then validates it with a Zod schema. */
export function parseJson<T>(schema: z.ZodType<T>, text: string): Checked<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['(root): not valid JSON; it may have been cut off'] };
  }
  const result = schema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, errors: formatIssues(result.error.issues) };
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');
}

/**
 * Generates until `check` accepts the text or the attempt budget runs out.
 * A rejected answer goes back to the model with the reasons, so it can fix
 * them. A ResampleError just draws again.
 */
export async function generateChecked<T>(options: {
  model: ModelClient;
  messages: readonly ChatMessage[];
  decoderSchema?: JsonSchemaNode;
  check: Check<T>;
  maxAttempts?: number;
  signal?: AbortSignal;
  onEvent?: (event: AssistantEvent) => void;
}): Promise<Generated<T>> {
  const { model, decoderSchema, check, signal, onEvent } = options;
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }
  const messages = [...options.messages];
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
        signal,
      });
    } catch (error: unknown) {
      if (isAbort(error, signal)) return { status: 'aborted', attempts: attempt };
      if (!(error instanceof ResampleError)) throw error;
      lastErrors = [error.message];
      continue;
    }
    if (signal?.aborted) return { status: 'aborted', attempts: attempt };

    const result = check(text);
    if (result.ok) return { status: 'ok', value: result.value, attempts: attempt };
    lastErrors = result.errors;

    onEvent?.({ kind: 'rejected', attempt, errors: lastErrors });
    messages.push(
      { role: 'assistant', content: text },
      {
        role: 'user',
        content:
          'That answer failed validation, so nothing was changed:\n' +
          lastErrors.map((e) => `- ${e}`).join('\n') +
          '\nFix these problems and answer again.',
      },
    );
  }
  return { status: 'failed', errors: lastErrors, attempts: maxAttempts };
}

/** Parses an answer into calls and applies them to a copy of the list, all or nothing. */
export function checkCalls<T extends { calls: readonly Call[] }>(
  schema: z.ZodType<T>,
  state: TodoState,
): Check<T & { state: TodoState }> {
  return (text) => {
    const shape = parseJson(schema, text);
    if (!shape.ok) return shape;
    const applied = applyCalls(state, shape.value.calls);
    return applied.ok
      ? { ok: true, value: { ...shape.value, state: applied.state } }
      : { ok: false, errors: applied.errors };
  };
}
