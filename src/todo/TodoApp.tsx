import { useState } from 'react';
import { FILTERS, type Call, type TodoState } from './schema';
import { remaining, visible } from './tools';

interface TodoAppProps {
  state: TodoState;
  /** Every control dispatches a tool call: the same calls, and the same checks, the assistant uses. */
  dispatch: (call: Call) => void;
  /** Ids the assistant just changed, briefly highlighted. */
  highlight?: ReadonlySet<string>;
  disabled?: boolean;
}

const FILTER_LABELS = { all: 'All', active: 'Active', completed: 'Completed' } as const;

/** TodoMVC, marked up for the official todomvc-app-css stylesheet. */
export function TodoApp({ state, dispatch, highlight, disabled = false }: TodoAppProps) {
  const [newTitle, setNewTitle] = useState('');
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const shown = visible(state);
  const left = remaining(state);
  const hasCompleted = state.todos.some((t) => t.completed);

  const commitEdit = () => {
    if (editing === null) return;
    // As in TodoMVC, clearing the text deletes the todo.
    dispatch(
      editing.title.trim() === ''
        ? { name: 'delete_todo', arguments: { id: editing.id } }
        : { name: 'edit_todo', arguments: editing },
    );
    setEditing(null);
  };

  return (
    <section className="todoapp" aria-busy={disabled}>
      <header className="header">
        <h1>todos</h1>
        <input
          className="new-todo"
          placeholder="What needs to be done?"
          aria-label="New todo"
          value={newTitle}
          disabled={disabled}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || newTitle.trim() === '') return;
            dispatch({ name: 'add_todo', arguments: { title: newTitle } });
            setNewTitle('');
          }}
        />
      </header>

      {state.todos.length > 0 && (
        <section className="main">
          <input
            id="toggle-all"
            className="toggle-all"
            type="checkbox"
            checked={left === 0}
            disabled={disabled}
            onChange={() => dispatch({ name: 'mark_all', arguments: { completed: left > 0 } })}
          />
          <label htmlFor="toggle-all">Mark all as complete</label>
          <ul className="todo-list">
            {shown.map((todo) => {
              const isEditing = editing?.id === todo.id;
              const classes = [
                todo.completed && 'completed',
                isEditing && 'editing',
                highlight?.has(todo.id) && 'flash',
              ].filter(Boolean);
              return (
                <li key={todo.id} className={classes.join(' ')} data-testid="todo">
                  <div className="view">
                    <input
                      className="toggle"
                      type="checkbox"
                      aria-label={`Toggle ${todo.title}`}
                      checked={todo.completed}
                      disabled={disabled}
                      onChange={() =>
                        dispatch({
                          name: 'mark_todo',
                          arguments: { id: todo.id, completed: !todo.completed },
                        })
                      }
                    />
                    <label
                      onDoubleClick={() =>
                        !disabled && setEditing({ id: todo.id, title: todo.title })
                      }
                    >
                      {todo.title}
                    </label>
                    <button
                      className="destroy"
                      aria-label={`Delete ${todo.title}`}
                      disabled={disabled}
                      onClick={() => dispatch({ name: 'delete_todo', arguments: { id: todo.id } })}
                    />
                  </div>
                  {isEditing && (
                    <input
                      className="edit"
                      aria-label={`Edit ${todo.title}`}
                      autoFocus
                      value={editing.title}
                      onChange={(e) => setEditing({ id: todo.id, title: e.target.value })}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitEdit();
                        if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {state.todos.length > 0 && (
        <footer className="footer">
          <span className="todo-count">
            <strong>{left}</strong> {left === 1 ? 'item' : 'items'} left
          </span>
          <ul className="filters">
            {FILTERS.map((filter) => (
              <li key={filter}>
                <a
                  href={`#/${filter === 'all' ? '' : filter}`}
                  className={state.filter === filter ? 'selected' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    if (!disabled) dispatch({ name: 'set_filter', arguments: { filter } });
                  }}
                >
                  {FILTER_LABELS[filter]}
                </a>
              </li>
            ))}
          </ul>
          {hasCompleted && (
            <button
              className="clear-completed"
              disabled={disabled}
              onClick={() => dispatch({ name: 'clear_completed', arguments: {} })}
            >
              Clear completed
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
