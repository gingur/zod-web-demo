import { z } from 'zod';

/** A TodoMVC item: nothing more, nothing less. */
export const todoSchema = z.object({
  id: z.string(),
  title: z.string().trim().min(1),
  completed: z.boolean(),
});
export type Todo = z.infer<typeof todoSchema>;

export const FILTERS = ['all', 'active', 'completed'] as const;
export const filterSchema = z.enum(FILTERS);
export type Filter = z.infer<typeof filterSchema>;

export interface TodoState {
  todos: readonly Todo[];
  filter: Filter;
  /** Next id suffix. Ids are short (`t1`, `t2`) so a small model can copy them reliably. */
  nextId: number;
}

const id = z.string().describe('The id of an existing todo, copied from the current list.');

/**
 * One tool per TodoMVC action, so anything the UI can do the assistant can do,
 * and nothing else. The UI dispatches these same calls. Each description is
 * the only definition of what the tool does: it is shown to the model in the
 * prompt and reused wherever the tools are listed.
 */
export const callSchema = z.discriminatedUnion('tool', [
  z
    .object({
      tool: z.literal('add_todo'),
      args: z.object({ title: z.string().trim().min(1, "A new todo's title can't be empty") }),
    })
    .describe('Add one new, active todo. Call it once per item.'),
  z
    .object({
      tool: z.literal('edit_todo'),
      args: z.object({ id, title: z.string().trim() }),
    })
    .describe("Rename a todo. An empty title deletes it, as in TodoMVC's inline editor."),
  z
    .object({ tool: z.literal('toggle_todo'), args: z.object({ id }) })
    .describe('Flip one todo between active and completed.'),
  z
    .object({ tool: z.literal('toggle_all'), args: z.object({ completed: z.boolean() }) })
    .describe(
      'Mark EVERY todo completed (true) or active (false). Only when asked about all todos.',
    ),
  z.object({ tool: z.literal('delete_todo'), args: z.object({ id }) }).describe('Delete one todo.'),
  z
    .object({ tool: z.literal('clear_completed'), args: z.object({}) })
    .describe('Delete every completed todo.'),
  z
    .object({ tool: z.literal('set_filter'), args: z.object({ filter: filterSchema }) })
    .describe('Show all, only active, or only completed todos.'),
]);
export type Call = z.infer<typeof callSchema>;
export type ToolName = Call['tool'];

/**
 * Everything the assistant returns on each turn: the changes to make, then a
 * text reply. `calls` comes first on purpose: the decoder writes keys in this
 * order, so the reply is written after, and about, the calls actually made.
 * Reply-first let the model announce changes it then never made.
 */
export const replySchema = z.object({
  calls: z.array(callSchema).max(10),
  reply: z.string().trim().min(1, 'Write a reply to the user'),
});
export type AssistantReply = z.infer<typeof replySchema>;

/** Tool name and description, in declaration order, read from the schema itself. */
export const TOOLS: readonly { name: ToolName; description: string }[] = callSchema.options.map(
  (option) => ({
    name: option.shape.tool.value,
    description: option.description ?? '',
  }),
);

export const initialState: TodoState = {
  todos: [
    { id: 't1', title: 'Buy milk', completed: false },
    { id: 't2', title: 'Walk the dog', completed: true },
    { id: 't3', title: 'Call mom', completed: false },
  ],
  filter: 'all',
  nextId: 4,
};
