import { z } from 'zod';
import { describeCalls } from '@/copilot/pipeline';
import { callSchema, contextSchema, TOOLS, type TodoState } from '@/todo/schema';
import { applyCall } from '@/todo/tools';

/*
 * WebMCP exposes the page's tools to whatever agent drives the browser. They
 * are the chat's seven tools, from the same Zod schemas, checked by the same
 * applyCall and reported by the same describeCalls. The one addition is
 * get_todos: the chat model is handed the list every turn, an outside agent
 * has to ask for it.
 */

/** The part of WebMCP this page uses: https://webmachinelearning.github.io/webmcp/ */
interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}
interface ModelContextTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: ToolAnnotations;
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}
/** MCP's result shape: what Chrome's origin trial expects, and readable as plain JSON elsewhere. */
interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: true;
}
export interface ModelContext {
  registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): unknown;
  /** Chrome's origin-trial API; it ignores `signal`. */
  unregisterTool?(name: string): void;
}

type WithModelContext = { modelContext?: ModelContext };

/** The spec puts it on document; Chrome's origin trial (149–156) still serves navigator. */
export function findModelContext(): ModelContext | undefined {
  return (
    (document as Document & WithModelContext).modelContext ??
    (navigator as Navigator & WithModelContext).modelContext
  );
}

export interface WebMcpHost {
  getState(): TodoState;
  commit(before: TodoState, after: TodoState): void;
  /** True while the in-page assistant runs; the UI's controls are disabled then too. */
  busy(): boolean;
}

// Titles are user text, so agents are told to read them as data.
const annotations: ToolAnnotations = { untrustedContentHint: true };

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const list = (state: TodoState) => JSON.stringify(contextSchema.parse(state));
const result = (reply: string, state: TodoState) =>
  text(`${reply}\nThe todo list now: ${list(state)}`);
/*
 * A refused call is returned, not thrown: Chrome hands a thrown error's
 * message only to the page's console, and the agent needs it to fix the call.
 */
const refused = (reason: string): ToolResult => ({ ...text(reason), isError: true });

export function webMcpTools(host: WebMcpHost): ModelContextTool[] {
  const read: ModelContextTool = {
    name: 'get_todos',
    description:
      'Read the todo list: every todo with its id, title and done state, and which todos the list is showing. The other tools take ids from it.',
    inputSchema: z.toJSONSchema(z.object({})),
    annotations: { ...annotations, readOnlyHint: true },
    execute: async () => text(list(host.getState())),
  };
  const writes = TOOLS.map(
    (tool): ModelContextTool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.arguments),
      annotations,
      execute: async (input) => {
        if (host.busy()) {
          return refused('The in-page assistant is changing the list. Try again in a moment.');
        }
        const before = host.getState();
        const raw = { name: tool.name, arguments: input };
        const applied = applyCall(before, raw);
        if (!applied.ok) return refused(applied.error);
        host.commit(before, applied.state);
        // Parsed again so the report shows the stored (trimmed) title.
        return result(describeCalls(before, [callSchema.parse(raw)]).join(' '), applied.state);
      },
    }),
  );
  return [read, ...writes];
}

/** Registers every tool until `signal` aborts. */
export function registerWebMcp(mc: ModelContext, host: WebMcpHost, signal: AbortSignal): void {
  for (const tool of webMcpTools(host)) {
    const warn = (error: unknown) => console.warn(`WebMCP: couldn't register ${tool.name}`, error);
    try {
      Promise.resolve(mc.registerTool(tool, { signal })).catch(warn);
    } catch (error: unknown) {
      warn(error);
    }
    signal.addEventListener('abort', () => {
      try {
        mc.unregisterTool?.(tool.name);
      } catch {
        // Already gone: the spec API unregisters on abort by itself.
      }
    });
  }
}
