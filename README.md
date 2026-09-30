# zod-web-demo

One Zod schema generates a form, constrains a browser-local LLM's output, and validates every edit, whether it comes from a person or the model. Everything runs client side and is served from GitHub Pages.

**Live:** https://gingur.github.io/zod-web-demo/ · **Storybook:** https://gingur.github.io/zod-web-demo/storybook/

## How it works

1. `src/schema/campaign.ts` is the only definition of the config, cross-field rules included.
2. `z.toJSONSchema()` produces the JSON Schema, and the form is generated from it (`src/form/fields.ts`). Shapes the generator can't render throw; the fix is to narrow the type, not grow the generator.
3. The model runs in the browser through [WebLLM](https://github.com/mlc-ai/web-llm) in a Web Worker. Decoding is constrained by a structural subset of the schema (types, enums, required keys), so it can't produce the wrong shape.
4. Zod then checks what the decoder can't: ranges, patterns, and cross-field rules such as "exit intent needs desktop". Failures go back to the model, up to 3 attempts (`src/copilot/loop.ts`).
5. Only a valid config reaches the form. Changed fields are highlighted and the chat shows a diff. A model result never overwrites an edit made while it was generating.

Scripted mode replays the suggested prompts through the same loop without a model, for browsers without WebGPU.

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
