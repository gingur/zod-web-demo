# zod-web-demo

TodoMVC with a chat assistant that runs in the browser. One Zod schema defines the tools, constrains the model's output, and validates every change, whether it comes from a click or from the model. Everything runs client side and is served from GitHub Pages.

**Live:** https://gingur.github.io/zod-web-demo/ · **Storybook:** https://gingur.github.io/zod-web-demo/storybook/

## How it works

1. `src/todo/schema.ts` defines seven tools, one per TodoMVC action: add, edit, toggle, toggle all, delete, clear completed, and filter. The assistant can do what the UI can do, and nothing else.
2. The UI's own controls dispatch those same tool calls through `src/todo/tools.ts`, so a click and a model call are checked the same way.
3. The model runs in the browser through [WebLLM](https://github.com/mlc-ai/web-llm) in a Web Worker. Every turn it returns `{ calls, reply }`, and decoding is constrained to that shape, so it always gives a text reply and can only name real tools. `calls` comes first so the reply describes the calls actually made.
4. Zod and the tools then check what the decoder can't, such as an id that doesn't exist or an empty title. The batch is applied all or nothing, and failures go back to the model, up to 3 attempts (`src/copilot/loop.ts`).
5. The system prompt (`src/copilot/prompt.ts`) gives it a support persona, lists the tools from the schema, and tells it to decline anything off topic. Todo titles are passed as data, not instructions. It sees the last 6 messages, so follow-ups work.

Scripted mode replays the suggested prompts through the same loop without a model, for browsers without WebGPU. One of them deliberately guesses a wrong id first, so the rejection and retry show on stage.

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
