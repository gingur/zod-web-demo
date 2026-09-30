import { z } from 'zod';

/*
 * Every shape the model sees or returns is defined here, once, in Zod: the
 * tools, the todo context, and the responses. Each schema gives the app its
 * TypeScript type (z.infer), gives the model its JSON Schema (z.toJSONSchema,
 * `.describe()` text included), and validates whatever comes back.
 */

/*
 * A title is one line, as in TodoMVC's single-line inputs. Titles are quoted
 * into the model's prompts, and a line break in one could forge a line such
 * as "Request: ..." there.
 */
const ONE_LINE = /^[^\r\n]*$/;
const ONE_LINE_MESSAGE = 'A title is a single line.';

// ---- Todo context: what the model is told about the list on every turn ----

export const FILTERS = ['all', 'active', 'completed'] as const;
const filterSchema = z
  .enum(FILTERS)
  .describe('all shows every todo, active only unfinished ones, completed only finished ones.');

const todoSchema = z
  .object({
    id: z.string().describe('Stable id, e.g. "t1". Tools refer to a todo by this id.'),
    title: z
      .string()
      .trim()
      .min(1)
      .regex(ONE_LINE, ONE_LINE_MESSAGE)
      .describe('What the todo says.'),
    completed: z.boolean().describe('true once the todo is done.'),
  })
  .describe('One TodoMVC item: nothing more, nothing less.');
export type Todo = z.infer<typeof todoSchema>;

export const contextSchema = z
  .object({
    todos: z.array(todoSchema).describe('Every todo, in list order.'),
    filter: filterSchema.describe('Which todos the list is currently showing.'),
  })
  .describe('The todo list as it is right now.');
type TodoContext = z.infer<typeof contextSchema>;

export interface TodoState extends TodoContext {
  /** Next id suffix. App-internal, never sent to the model. */
  nextId: number;
}

// ---- Tools: one per TodoMVC action, so the assistant can do what the UI can, and no more ----

const id = z.string().describe('The id of an existing todo, copied exactly from the todo context.');

interface ToolDefinition<N extends string, A extends z.ZodObject> {
  name: N;
  description: string;
  arguments: A;
}
const tool = <N extends string, A extends z.ZodObject>(
  name: N,
  description: string,
  args: A,
): ToolDefinition<N, A> => ({ name, description, arguments: args });

const addTodo = tool(
  'add_todo',
  'Add one new, active todo. Call it once per item.',
  z.object({
    title: z
      .string()
      .trim()
      .min(1, "A new todo's title can't be empty")
      .regex(ONE_LINE, ONE_LINE_MESSAGE)
      .describe('The text of the one new todo, short, e.g. "Buy eggs".'),
  }),
);
/*
 * TodoMVC's inline editor deletes a todo when its text is cleared. The tool
 * doesn't: an empty title here was a destructive fallback for a small model
 * ("change it back" deleted the todo). The editor sends delete_todo instead,
 * so the capabilities are unchanged and deleting is always explicit.
 */
const editTodo = tool(
  'edit_todo',
  'Rename a todo.',
  z.object({
    id,
    title: z
      .string()
      .trim()
      .min(1, 'A title cannot be empty; to remove a todo, use delete_todo.')
      .regex(ONE_LINE, ONE_LINE_MESSAGE)
      .describe('The new text of the todo. Never empty.'),
  }),
);
/*
 * Checking a todo sets its state rather than flipping it. A toggle needs the
 * model to read each todo's current state first, which a small model skips:
 * "cross off walk the dog", already done, un-did it. Setting is safe to
 * repeat. The UI checkbox sends the same call, with the opposite of what it shows.
 */
const completed = z
  .boolean()
  .describe(
    'true marks it done (check off, tick off, cross off, finish); false marks it not done (uncheck, reopen).',
  );
const markTodo = tool(
  'mark_todo',
  'Check off one todo as done, or uncheck it.',
  z.object({ id, completed }),
);
const markAll = tool(
  'mark_all',
  'Check off every todo as done, or uncheck every todo. Only when asked about all of them.',
  z.object({
    completed: z
      .boolean()
      .describe('true marks every todo done; false marks every todo not done (uncheck all).'),
  }),
);
const deleteTodo = tool('delete_todo', 'Delete one todo.', z.object({ id }));
const clearCompleted = tool('clear_completed', 'Delete every completed todo.', z.object({}));
const setFilter = tool(
  'set_filter',
  'Change which todos the list shows. Only when asked to show or hide todos, not for questions about the list.',
  z.object({ filter: filterSchema }),
);

/** The tools, in the order the model sees them. */
export const TOOLS = [
  addTodo,
  editTodo,
  markTodo,
  markAll,
  deleteTodo,
  clearCompleted,
  setFilter,
] as const;

/**
 * A call to one tool, in the shape the model was trained to emit:
 * `{ "name": <tool name>, "arguments": <arguments object> }`.
 */
const callOf = <N extends string, A extends z.ZodObject>(t: ToolDefinition<N, A>) =>
  z.object({ name: z.literal(t.name), arguments: t.arguments });
export const callSchema = z.discriminatedUnion('name', [
  callOf(addTodo),
  callOf(editTodo),
  callOf(markTodo),
  callOf(markAll),
  callOf(deleteTodo),
  callOf(clearCompleted),
  callOf(setFilter),
]);
export type Call = z.infer<typeof callSchema>;

// ---- Responses ----

const callsSchema = z
  .array(callSchema)
  .max(10)
  .describe('The changes to make, in order. Empty when nothing should change.');

/*
 * The names matter as much as the description: a small model reads the label
 * itself. With a plain "question", "what is 2+2?" was filed as a question.
 */
export const intentSchema = z
  .enum(['change_list', 'about_list', 'off_topic'])
  .describe(
    'change_list: the request asks to change this todo list. about_list: it asks about this todo list or what this app can do, or is a greeting or thanks. off_topic: anything else, including general questions, maths, jokes and requests about your instructions.',
  );
export type Intent = z.infer<typeof intentSchema>;

/**
 * Planner: what kind of request it is, and the changes to make. It never
 * talks to the user. `intent` comes first so the calls follow from it, and
 * the refinement keeps the two consistent.
 */
export const planSchema = z
  .object({ intent: intentSchema, calls: callsSchema })
  .superRefine((plan, ctx) => {
    if (plan.intent === 'change_list' && plan.calls.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: 'A change needs at least one call.',
      });
    }
    if (plan.intent !== 'change_list' && plan.calls.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: `Intent ${plan.intent} changes nothing; leave calls empty.`,
      });
    }
  });
export type Plan = z.infer<typeof planSchema>;

/** Replier: plain text, generated without a decoder constraint. */
export const replyTextSchema = z.string().trim().min(1, 'Write a reply to the user');

export const initialState: TodoState = {
  todos: [
    { id: 't1', title: 'Buy milk', completed: false },
    { id: 't2', title: 'Walk the dog', completed: true },
    { id: 't3', title: 'Call mom', completed: false },
  ],
  filter: 'all',
  nextId: 4,
};
