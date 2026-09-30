import { callSchema, type Call, type Todo, type TodoState } from './schema';

type CallResult = { ok: true; state: TodoState } | { ok: false; error: string };
type BatchResult = { ok: true; state: TodoState } | { ok: false; errors: string[] };

/**
 * Applies one tool call. The UI and the assistant both come through here, so
 * a call is validated the same way whoever makes it. Input is re-parsed with
 * the schema rather than trusted, because it may come straight from a model.
 */
export function applyCall(state: TodoState, input: Call): CallResult {
  const parsed = callSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  const call = parsed.data;
  if ('id' in call.args) {
    const { id } = call.args;
    if (!state.todos.some((t) => t.id === id)) {
      return {
        ok: false,
        error: `There is no todo with id "${id}". Copy the id from the current list.`,
      };
    }
  }
  const withTodos = (todos: readonly Todo[]): CallResult => ({
    ok: true,
    state: { ...state, todos },
  });

  switch (call.tool) {
    case 'add_todo':
      return {
        ok: true,
        state: {
          ...state,
          todos: [
            ...state.todos,
            { id: `t${state.nextId}`, title: call.args.title, completed: false },
          ],
          nextId: state.nextId + 1,
        },
      };
    case 'edit_todo': {
      const { id, title } = call.args;
      return withTodos(
        title === ''
          ? state.todos.filter((t) => t.id !== id)
          : state.todos.map((t) => (t.id === id ? { ...t, title } : t)),
      );
    }
    case 'toggle_todo':
      return withTodos(
        state.todos.map((t) => (t.id === call.args.id ? { ...t, completed: !t.completed } : t)),
      );
    case 'toggle_all':
      return withTodos(state.todos.map((t) => ({ ...t, completed: call.args.completed })));
    case 'delete_todo':
      return withTodos(state.todos.filter((t) => t.id !== call.args.id));
    case 'clear_completed':
      return withTodos(state.todos.filter((t) => !t.completed));
    case 'set_filter':
      return { ok: true, state: { ...state, filter: call.args.filter } };
  }
}

/** Applies calls in order. All or nothing: one failure leaves the state untouched. */
export function applyCalls(state: TodoState, calls: readonly Call[]): BatchResult {
  let next = state;
  for (const [i, call] of calls.entries()) {
    const result = applyCall(next, call);
    if (!result.ok) return { ok: false, errors: [`calls.${i} (${call.tool}): ${result.error}`] };
    next = result.state;
  }
  return { ok: true, state: next };
}

export function visible(state: TodoState): readonly Todo[] {
  if (state.filter === 'all') return state.todos;
  const completed = state.filter === 'completed';
  return state.todos.filter((t) => t.completed === completed);
}

export function remaining(state: TodoState): number {
  return state.todos.filter((t) => !t.completed).length;
}
