import { describe, expect, test } from 'vitest';
import { initialState, TOOLS, type Call, type TodoState } from './schema';
import { applyCall, applyCalls, remaining, visible } from './tools';

const titles = (s: TodoState) =>
  s.todos.map((t) => `${t.id}:${t.title}:${t.completed ? 'x' : ' '}`);

function ok(state: TodoState, call: Call): TodoState {
  const result = applyCall(state, call);
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

describe('applyCall', () => {
  test('add_todo appends an active todo with the next id and a trimmed title', () => {
    const next = ok(initialState, { name: 'add_todo', arguments: { title: '  Eggs  ' } });
    expect(next.todos.at(-1)).toEqual({ id: 't4', title: 'Eggs', completed: false });
    expect(next.nextId).toBe(5);
  });

  test('add_todo refuses an empty title', () => {
    expect(applyCall(initialState, { name: 'add_todo', arguments: { title: '   ' } })).toEqual({
      ok: false,
      error: "A new todo's title can't be empty",
    });
  });

  test('edit_todo renames, and refuses an empty title: deleting is always explicit', () => {
    const renamed = ok(initialState, {
      name: 'edit_todo',
      arguments: { id: 't3', title: ' Call dad ' },
    });
    expect(renamed.todos.find((t) => t.id === 't3')?.title).toBe('Call dad');
    expect(
      applyCall(initialState, { name: 'edit_todo', arguments: { id: 't3', title: '  ' } }),
    ).toEqual({
      ok: false,
      error: 'A title cannot be empty; to remove a todo, use delete_todo.',
    });
  });

  test('toggle_todo flips one todo', () => {
    const next = ok(initialState, { name: 'toggle_todo', arguments: { id: 't1' } });
    expect(next.todos[0]?.completed).toBe(true);
  });

  test('toggle_all sets every todo', () => {
    const done = ok(initialState, { name: 'toggle_all', arguments: { completed: true } });
    expect(done.todos.every((t) => t.completed)).toBe(true);
    const active = ok(done, { name: 'toggle_all', arguments: { completed: false } });
    expect(active.todos.some((t) => t.completed)).toBe(false);
  });

  test('delete_todo and clear_completed remove todos', () => {
    expect(titles(ok(initialState, { name: 'delete_todo', arguments: { id: 't1' } }))).toEqual([
      't2:Walk the dog:x',
      't3:Call mom: ',
    ]);
    expect(titles(ok(initialState, { name: 'clear_completed', arguments: {} }))).toEqual([
      't1:Buy milk: ',
      't3:Call mom: ',
    ]);
  });

  test('set_filter changes the view, not the todos', () => {
    const next = ok(initialState, { name: 'set_filter', arguments: { filter: 'active' } });
    expect(next.filter).toBe('active');
    expect(next.todos).toBe(initialState.todos);
    expect(visible(next).map((t) => t.id)).toEqual(['t1', 't3']);
  });

  test('an unknown id is refused and tells the model to copy an id from the list', () => {
    for (const tool of ['toggle_todo', 'delete_todo'] as const) {
      const result = applyCall(initialState, { name: tool, arguments: { id: 't9' } });
      expect(result).toEqual({
        ok: false,
        error: 'There is no todo with id "t9". Copy the id from the todo context.',
      });
    }
  });

  test('a malformed call is refused by the schema, not trusted', () => {
    const result = applyCall(initialState, {
      name: 'set_filter',
      arguments: { filter: 'done' },
    } as never);
    expect(result.ok).toBe(false);
  });
});

describe('applyCalls', () => {
  test('applies a batch in order', () => {
    const result = applyCalls(initialState, [
      { name: 'add_todo', arguments: { title: 'Eggs' } },
      { name: 'toggle_todo', arguments: { id: 't4' } },
    ]);
    expect(result.ok && titles(result.state).at(-1)).toBe('t4:Eggs:x');
  });

  test('is all or nothing, and reports which call failed', () => {
    const result = applyCalls(initialState, [
      { name: 'delete_todo', arguments: { id: 't1' } },
      { name: 'toggle_todo', arguments: { id: 't1' } },
    ]);
    expect(result).toEqual({
      ok: false,
      errors: [
        'calls.1 (toggle_todo): There is no todo with id "t1". Copy the id from the todo context.',
      ],
    });
  });

  test('an empty batch leaves the state untouched', () => {
    const result = applyCalls(initialState, []);
    expect(result.ok && result.state).toBe(initialState);
  });
});

test('remaining counts active todos', () => {
  expect(remaining(initialState)).toBe(2);
});

test('the tool list comes from the schema, one per TodoMVC action', () => {
  expect(TOOLS.map((t) => t.name)).toEqual([
    'add_todo',
    'edit_todo',
    'toggle_todo',
    'toggle_all',
    'delete_todo',
    'clear_completed',
    'set_filter',
  ]);
  expect(TOOLS.every((t) => t.description.length > 0)).toBe(true);
});
