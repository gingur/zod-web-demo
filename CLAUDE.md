# zod-web-demo

Client-side demo: TodoMVC plus an in-browser assistant. One Zod schema defines the tools, constrains a WebLLM model's output, and validates every change, from the UI or the model. Static build on GitHub Pages. Consumer of [`gingur/devkit`](https://github.com/gingur/devkit); follow its consumer standards.

## Commands

- `pnpm dev`, `pnpm storybook`
- `pnpm test` (unit), `pnpm test:stories` (Storybook in headless Chromium; `pnpm exec playwright install chromium` once)
- `pnpm typecheck`, `pnpm lint`, `pnpm fmt`
- `pnpm build` (app, plus Storybook at `dist/storybook`)

CI runs devkit's `toolchain.verify` with `test: 'test:ci'`, which installs Chromium and runs both test projects.

## Layout

- `src/todo/`: the schema (todo, the seven tools, the `{ calls, reply }` answer shape), the tool reducer, and the TodoMVC component.
- `src/copilot/`: the prompt (persona, tools, worked examples, history), the validate-and-retry loop (`loop.ts`), the WebLLM client (runs in `worker.ts`), the scripted fallback model, and the chat panel.
- `src/schema/jsonSchema.ts`: Zod to JSON Schema, and `toDecoderSchema`, which keeps only the structural keywords the decoder needs.
- `src/components/ui/`: the few shadcn-style primitives the chat panel uses, on Tailwind v4.

## Rules

- Keep it simple: this is a demo.
- Capabilities are exactly TodoMVC's. Every UI action is a tool, and the assistant has no tool the UI lacks. Don't add one without adding the UI for it.
- The schema is the contract. Tool descriptions live in `.describe()` on the schema and are read from there; don't restate them elsewhere.
- UI and model changes both go through `applyCall`/`applyCalls`. The model never writes to the list directly: a whole batch is validated and applied, or nothing is, and it's discarded if the list changed while the model ran.
- `calls` stays before `reply` in `replySchema`. The decoder writes keys in order, and reply-first let the model claim changes it never made.
- Todo titles reach the model as data, labelled as such, never as instructions.
- Behavior changes need a unit test or a story with a `play` function. Stories are tests here (`tags: ['test']` in `.storybook/preview.ts`).
- Asset paths stay relative (`base: './'`) so Pages' `/zod-web-demo/` subpath works.
- `todomvc-app-css` is CC BY 4.0 and imported into Tailwind's `base` layer; keep the README credit.
