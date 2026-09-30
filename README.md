# zod-web-demo

TodoMVC with a chat assistant that runs in the browser. Zod defines the tools, the todo context and the model's responses: each schema is the app's type, the JSON Schema the model reads, and the validation of what comes back. Everything runs client side and is served from GitHub Pages.

**Live:** https://gingur.github.io/zod-web-demo/ · **Storybook:** https://gingur.github.io/zod-web-demo/storybook/

## How it works

1. `src/todo/schema.ts` defines seven tools, one per TodoMVC action: add, edit, toggle, toggle all, delete, clear completed, and filter. Each is a name, a description, and a Zod object for its arguments with a `.describe()` on every field. The assistant can do what the UI can do, and nothing else.
2. The UI's own controls dispatch those same tool calls through `src/todo/tools.ts`, so a click and a model call are checked the same way.
3. The model runs in the browser through [WebLLM](https://github.com/mlc-ai/web-llm) in a Web Worker. It reads the tools as definitions generated from Zod, in the `<tools>` format its chat template uses, and the todo context as JSON with its schema (`src/copilot/prompt.ts`).
4. Each turn, the model plans (`src/copilot/pipeline.ts`): it returns `{ intent, calls }`, where intent is `change`, `question` or `off_topic`, with decoding constrained to that shape. Zod and the tools check what the decoder can't, such as an id that doesn't exist or an intent that disagrees with its calls. Calls are applied all or nothing, and failures go back to the model, up to 3 attempts (`src/copilot/loop.ts`).
5. The reply depends on the intent. A change is reported as the facts of what happened, written by code, so it is always true. An off-topic request gets a fixed decline. Only a question is answered in the model's own words, given the list and its counts.

The split is measured, not assumed: on the same 20 prompts with Qwen2.5 3B, a single pass that planned and replied in one go misreported changes it made or didn't make; planning with the model and reporting with code got 17–18 of 20 right with every reply true.

Scripted mode replays the suggested prompts through the same pipeline without a model, for browsers without WebGPU. One of them deliberately guesses a wrong id first, so the rejection and retry show on stage.

## Develop

Toolchain versions live in `.nvmrc` and `packageManager`; `proto install` sets them up.

```bash
pnpm install
pnpm dev             # app at http://localhost:5173
pnpm storybook       # stories at http://localhost:6006
pnpm test            # unit tests
pnpm test:stories    # story interaction tests in headless Chromium
pnpm build           # app + Storybook into dist/
```

Lint, format and git hooks come from [`@gingur/devkit`](https://github.com/gingur/devkit): `pnpm lint`, `pnpm fmt`.

## Live demo checklist

- Use a recent Chrome or Edge (WebGPU), in the same browser profile you'll present from.
- Load the model once beforehand so its weights are cached. Qwen2.5 3B is the default; use 1.5B if generation is slow.
- Run each suggested prompt and time it, then check the tab over your screen-share tool.
- Reload right before presenting and click **Load**; cached loads take seconds.

## CI

- `verify.yml`: devkit's `toolchain.verify` on every PR (format, lint, typecheck, unit and story tests, build). Required for `main`.
- `gh.pages.deploy.yml`: builds and deploys to Pages on push to `main`.
- `infisical.secrets.scan.yml`: devkit's secret scan on every PR.

## Credits

The todo list's look is the official [TodoMVC](https://todomvc.com) stylesheet, [`todomvc-app-css`](https://github.com/tastejs/todomvc-app-css) by Sindre Sorhus, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). It is used unmodified; `src/index.css` only adjusts the page around it.
