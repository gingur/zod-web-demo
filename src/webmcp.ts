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
/*
 * Plain JSON, which the spec allows. Chrome serializes it once; an MCP
 * content wrapper would only nest a second encoding, and Chrome ignores isError.
 */
type TodoList = z.infer<typeof contextSchema>;
type ToolResult = ({ ok: true; message?: string } & TodoList) | { ok: false; error: string };
export interface ModelContext {
  registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): unknown;
  /** Older origin-trial builds only; Chrome 156 has none and unregisters on `signal` abort. */
  unregisterTool?(name: string): void;
}

type WithModelContext = { modelContext?: ModelContext };

/** The spec and Chrome 156 put it on document; navigator is for older origin-trial builds. */
function findModelContext(): ModelContext | undefined {
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

const list = (state: TodoState): TodoList => contextSchema.parse(state);
/*
 * A refused call is returned, not thrown: Chrome hands a thrown error's
 * message only to the page's console, and the agent needs it to fix the call.
 */
const refused = (error: string): ToolResult => ({ ok: false, error });

/** Not a standard: an agent whose browser lacks WebMCP dispatches this after defining its own modelContext. */
const PROVIDE_EVENT = 'webmcp:provide';

/*
 * The spec has no discovery mechanism yet (webmachinelearning/webmcp#340), and
 * a page can't tell an agent from a person, so the page states this to everyone.
 * It leads with the key phrase because agent page readers cut long text, and it
 * describes rather than instructs because agents read page text as data.
 */
export const WEBMCP_HINT = `WebMCP tools on document.modelContext: this page registers its todo actions there. Without a native document.modelContext, it registers them on one defined later, on a window '${PROVIDE_EVENT}' event or a call to window.registerWebMCPTools().`;

export function webMcpTools(host: WebMcpHost): ModelContextTool[] {
  const read: ModelContextTool = {
    name: 'get_todos',
    description:
      'Read the todo list: every todo with its id, title and done state, and which todos the list is showing. The other tools take ids from it.',
    inputSchema: z.toJSONSchema(z.object({})),
    annotations: { ...annotations, readOnlyHint: true },
    execute: async () => ({ ok: true, ...list(host.getState()) }),
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
        // Chrome doesn't check input against inputSchema, so this is the only check.
        const applied = applyCall(before, raw);
        if (!applied.ok) return refused(applied.error);
        host.commit(before, applied.state);
        // Parsed again so the report shows the stored (trimmed) title.
        const message = describeCalls(before, [callSchema.parse(raw)]).join(' ');
        return { ok: true, message, ...list(applied.state) };
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

type RegisterTools = (mc?: ModelContext) => () => void;

declare global {
  interface Window {
    registerWebMCPTools?: RegisterTools;
  }
}

/**
 * Registers the tools now if the browser has WebMCP, and later whenever an agent
 * provides its own modelContext. Returns a cleanup that removes all of it.
 */
export function connectWebMcp(host: WebMcpHost): () => void {
  // A native modelContext found at mount stays; the late path is only for agent-provided ones.
  const native = findModelContext();
  let current: { mc: ModelContext; cleanup: () => void } | undefined;

  const registerTools: RegisterTools = (mc = findModelContext()) => {
    if (mc === undefined || mc === current?.mc || (native !== undefined && mc !== native)) {
      return current?.cleanup ?? (() => {});
    }
    current?.cleanup();
    const controller = new AbortController();
    registerWebMcp(mc, host, controller.signal);
    const cleanup = () => {
      controller.abort();
      if (current?.mc === mc) current = undefined;
    };
    current = { mc, cleanup };
    return cleanup;
  };
  const onProvide = (event: Event) => {
    const detail: unknown = (event as CustomEvent).detail;
    const provided =
      typeof detail === 'object' && detail !== null && 'modelContext' in detail
        ? (detail.modelContext as ModelContext)
        : undefined;
    registerTools(provided);
  };

  registerTools();
  window.addEventListener(PROVIDE_EVENT, onProvide);
  window.registerWebMCPTools = registerTools;
  return () => {
    window.removeEventListener(PROVIDE_EVENT, onProvide);
    if (window.registerWebMCPTools === registerTools) delete window.registerWebMCPTools;
    current?.cleanup();
  };
}
