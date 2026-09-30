import type { z } from 'zod';
import type { JsonSchemaNode } from '@/schema/jsonSchema';
import { diff, type Change } from './diff';

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

export type CopilotEvent<T> =
  | { kind: 'attempt'; attempt: number }
  | { kind: 'text'; attempt: number; text: string }
  | { kind: 'rejected'; attempt: number; errors: string[] }
  | { kind: 'applied'; attempt: number; config: T; changes: Change[] };

export type CopilotResult<T> =
  | { status: 'applied'; config: T; changes: Change[]; attempts: number }
  | { status: 'unchanged'; attempts: number }
  | { status: 'failed'; errors: string[]; attempts: number }
  | { status: 'aborted'; attempts: number };

export interface RunCopilotOptions<T> {
  schema: z.ZodType<T>;
  /** Full JSON Schema, shown to the model in the prompt. */
  promptSchema: JsonSchemaNode;
  /** Structural subset, used to constrain decoding. */
  decoderSchema: JsonSchemaNode;
  crossFieldRules: readonly string[];
  current: T;
  request: string;
  model: ModelClient;
  today: string;
  maxAttempts?: number;
  signal?: AbortSignal;
  onEvent?: (event: CopilotEvent<T>) => void;
}

export function buildMessages(options: {
  promptSchema: JsonSchemaNode;
  crossFieldRules: readonly string[];
  current: unknown;
  request: string;
  today: string;
}): ChatMessage[] {
  const system = [
    'You edit a JSON configuration for a marketing popup campaign.',
    'Return the COMPLETE updated configuration as a single JSON object that matches the schema.',
    'Change only what the request asks for; copy every other value exactly as it is.',
    `Today's date is ${options.today}. Dates use YYYY-MM-DD.`,
    '',
    "Rules the schema can't express, which must also hold:",
    ...options.crossFieldRules.map((r) => `- ${r}`),
    '',
    'JSON Schema:',
    JSON.stringify(options.promptSchema),
  ].join('\n');

  const user = `Current configuration:\n${JSON.stringify(options.current, null, 2)}\n\nRequest: ${options.request}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
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
 * One request from the chat panel. The model proposes a full config under a
 * constrained decoder; Zod then checks everything the decoder can't (ranges,
 * patterns, cross-field rules). Failures are sent back to the model until it
 * passes or the attempt budget runs out. Nothing reaches the form unless the
 * whole config is valid.
 */
export async function runCopilot<T>(options: RunCopilotOptions<T>): Promise<CopilotResult<T>> {
  const { schema, current, model, signal, onEvent } = options;
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }

  const messages = buildMessages(options);
  let lastErrors: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) return { status: 'aborted', attempts: attempt - 1 };
    onEvent?.({ kind: 'attempt', attempt });

    let text: string;
    try {
      text = await model.generate({
        messages,
        decoderSchema: options.decoderSchema,
        onText: (t) => onEvent?.({ kind: 'text', attempt, text: t }),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error: unknown) {
      if (isAbort(error, signal)) return { status: 'aborted', attempts: attempt };
      throw error;
    }
    if (signal?.aborted) return { status: 'aborted', attempts: attempt };

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
      lastErrors = ['(root): the response was not valid JSON; it may have been cut off'];
    }

    if (parsed !== undefined) {
      const result = schema.safeParse(parsed);
      if (result.success) {
        const changes = diff(current, result.data);
        if (changes.length === 0) return { status: 'unchanged', attempts: attempt };
        onEvent?.({ kind: 'applied', attempt, config: result.data, changes });
        return { status: 'applied', config: result.data, changes, attempts: attempt };
      }
      lastErrors = formatIssues(result.error.issues);
    }

    onEvent?.({ kind: 'rejected', attempt, errors: lastErrors });
    messages.push(
      { role: 'assistant', content: text },
      {
        role: 'user',
        content:
          'That configuration failed validation:\n' +
          lastErrors.map((e) => `- ${e}`).join('\n') +
          '\nFix these problems and return the complete corrected configuration.',
      },
    );
  }

  return { status: 'failed', errors: lastErrors, attempts: maxAttempts };
}
