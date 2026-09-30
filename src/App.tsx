import { useMemo, useRef, useState } from 'react';
import { initialState, type Call, type TodoState } from '@/todo/schema';
import { applyCall } from '@/todo/tools';
import { TodoApp } from '@/todo/TodoApp';
import { ChatPanel, type EngineState, type Turn } from '@/copilot/ChatPanel';
import { runAssistant, type ChatMessage, type ModelClient } from '@/copilot/loop';
import { partialReply } from '@/copilot/prompt';
import { createScriptedModel, SUGGESTED_PROMPTS } from '@/copilot/scripted';
import { DEFAULT_MODEL_ID, MODEL_OPTIONS, hasWebGPU, loadWebLLM } from '@/copilot/webllm';

const suggestions = SUGGESTED_PROMPTS.map((p) => p.text);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ids a turn added or changed, so the list can flash them. */
function touchedIds(before: TodoState, after: TodoState): Set<string> {
  const old = new Map(before.todos.map((t) => [t.id, t]));
  return new Set(
    after.todos
      .filter((t) => {
        const prev = old.get(t.id);
        return prev === undefined || prev.title !== t.title || prev.completed !== t.completed;
      })
      .map((t) => t.id),
  );
}

export function App() {
  const webgpu = useMemo(hasWebGPU, []);
  const [todos, setTodos] = useState<TodoState>(initialState);
  const todosRef = useRef<TodoState>(initialState);
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set());

  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [engine, setEngine] = useState<EngineState>({ kind: 'idle' });
  const modelRef = useRef<(ModelClient & { unload?: () => Promise<void> }) | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const historyRef = useRef<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextTurnId = useRef(1);

  const commit = (next: TodoState) => {
    todosRef.current = next;
    setTodos(next);
  };

  /** The UI's controls go through the same validated tools as the assistant. */
  const dispatch = (call: Call) => {
    const result = applyCall(todosRef.current, call);
    if (result.ok) {
      commit(result.state);
      setHighlight(new Set());
    }
  };

  const updateTurn = (id: number, update: (t: Turn) => Turn) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? update(t) : t)));

  async function loadModel(): Promise<void> {
    const option = MODEL_OPTIONS.find((m) => m.id === modelId);
    if (option === undefined) return;
    setEngine({ kind: 'loading', progress: { fraction: 0, text: 'Starting…' } });
    try {
      await modelRef.current?.unload?.();
      modelRef.current = await loadWebLLM(option, (progress) =>
        setEngine({ kind: 'loading', progress }),
      );
      setEngine({ kind: 'ready', label: option.label, scripted: false });
    } catch (error: unknown) {
      modelRef.current = null;
      setEngine({ kind: 'error', message: errorMessage(error) });
    }
  }

  function enableScripted(): void {
    modelRef.current = createScriptedModel();
    setEngine({ kind: 'ready', label: 'Scripted mode', scripted: true });
  }

  async function send(request: string): Promise<void> {
    const model = modelRef.current;
    if (model === null || running) return;
    const id = nextTurnId.current++;
    const snapshot = todosRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setTurns((ts) => [
      ...ts,
      { id, request, status: 'running', reply: '', calls: [], rejected: [] },
    ]);

    let status: Turn['status'];
    let reply: string;
    let applied: readonly Call[] = [];
    try {
      const result = await runAssistant({
        state: snapshot,
        history: historyRef.current,
        request,
        model,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.kind === 'attempt') updateTurn(id, (t) => ({ ...t, reply: '' }));
          if (event.kind === 'text')
            updateTurn(id, (t) => ({ ...t, reply: partialReply(event.text) }));
          if (event.kind === 'rejected') {
            updateTurn(id, (t) => ({
              ...t,
              rejected: [...t.rejected, { attempt: event.attempt, errors: event.errors }],
            }));
          }
        },
      });

      switch (result.status) {
        case 'done':
          if (todosRef.current !== snapshot) {
            // The list changed while the model worked; don't overwrite that edit.
            status = 'failed';
            reply =
              "Your list changed while I was working, so I didn't make those changes. Please ask again.";
            break;
          }
          status = 'done';
          reply = result.reply;
          applied = result.calls;
          commit(result.state);
          setHighlight(touchedIds(snapshot, result.state));
          break;
        case 'failed':
          status = 'failed';
          reply = `Sorry, I couldn't do that without breaking a rule, so I didn't change anything. (${result.errors.join('; ')})`;
          break;
        case 'aborted':
          status = 'aborted';
          reply = 'Stopped. Nothing was changed.';
          break;
      }
    } catch (error: unknown) {
      status = 'error';
      reply = `Something went wrong: ${errorMessage(error)}`;
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
    updateTurn(id, (t) => ({ ...t, status, reply, calls: applied }));
    // History records what actually happened, in the same shape the model answers in,
    // so a follow-up like "change that back" can see the calls it refers to.
    historyRef.current = [
      ...historyRef.current,
      { role: 'user', content: request },
      { role: 'assistant', content: JSON.stringify({ calls: applied, reply }) },
    ];
  }

  function reset(): void {
    commit(initialState);
    setHighlight(new Set());
    setTurns([]);
    historyRef.current = [];
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-6 py-3">
        <div>
          <h1 className="text-base font-semibold">TodoMVC + Todo Assistant</h1>
          <p className="text-sm text-muted-foreground">
            One Zod schema defines the tools, constrains the model, and validates every change, from
            you or the AI.
          </p>
        </div>
        <button
          type="button"
          onClick={reset}
          disabled={running}
          className="rounded-md px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          Reset
        </button>
      </header>

      <main className="grid min-h-0 flex-1 gap-6 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1fr)_420px] lg:overflow-hidden">
        <div className="lg:overflow-y-auto">
          <div className="mx-auto w-full max-w-[550px] pb-10">
            <TodoApp state={todos} dispatch={dispatch} highlight={highlight} disabled={running} />
          </div>
        </div>
        <div className="min-h-[520px] lg:min-h-0">
          <ChatPanel
            engine={engine}
            webgpu={webgpu}
            modelId={modelId}
            onModelIdChange={setModelId}
            onLoad={loadModel}
            onUseScripted={enableScripted}
            turns={turns}
            running={running}
            suggestions={suggestions}
            onSend={send}
            onStop={() => abortRef.current?.abort()}
          />
        </div>
      </main>
    </div>
  );
}
