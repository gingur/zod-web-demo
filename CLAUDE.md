# zod-web-demo

Client-side demo: one Zod schema drives a generated form, schema-constrained decoding for a WebLLM model, and validation of every edit. Static build on GitHub Pages. Consumer of [`gingur/devkit`](https://github.com/gingur/devkit); follow its consumer standards.

## Commands

- `pnpm dev`, `pnpm storybook`
- `pnpm test` (unit), `pnpm test:stories` (Storybook in headless Chromium; `pnpm exec playwright install chromium` once)
- `pnpm typecheck`, `pnpm lint`, `pnpm fmt`
- `pnpm build` (app, plus Storybook at `dist/storybook`)

CI runs devkit's `toolchain.verify` with `test: 'test:ci'`, which installs Chromium and runs both test projects.

## Layout

- `src/schema/`: the Zod schema (single source of truth) and JSON Schema helpers. `toDecoderSchema` keeps only structural keywords; everything else stays enforced by Zod.
- `src/form/`: generator from JSON Schema to fields, and the renderer. Unsupported shapes throw `UnsupportedFieldError`; narrow the schema rather than extend the generator.
- `src/copilot/`: the validate-and-retry loop (`loop.ts`), diffing, the WebLLM client (runs in `worker.ts`), and the scripted fallback model.
- `src/components/ui/`: shadcn-style primitives on Tailwind v4.

## Rules

- The schema is the contract. Don't duplicate its rules in UI or prompt code; derive them (`CROSS_FIELD_RULES` is the one plain-language copy, for the prompt).
- The model never writes to the form directly: every result goes through `campaignSchema.safeParse` and is discarded if the form changed while it ran.
- Behavior changes need a unit test or a story with a `play` function. Stories are tests here (`tags: ['test']` in `.storybook/preview.ts`).
- Asset paths stay relative (`base: './'`) so Pages' `/zod-web-demo/` subpath works.
- Campaign fields are generic and illustrative. Don't add anything modeled on a real company's system.
