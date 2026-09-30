import { useCallback, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card } from '@/components/ui';
import { cn } from '@/lib/utils';
import { setAt, type Path } from '@/lib/path';
import {
  CROSS_FIELD_RULES,
  campaignSchema,
  defaultCampaign,
  type Campaign,
} from '@/schema/campaign';
import { toDecoderSchema, toJsonSchema } from '@/schema/jsonSchema';
import { deriveFields } from '@/form/fields';
import { SchemaForm } from '@/form/SchemaForm';
import { validationErrors } from '@/form/errors';
import { ChatPanel, type EngineState, type Turn } from '@/copilot/ChatPanel';
import { changedPrefixes } from '@/copilot/diff';
import { runCopilot, type ModelClient } from '@/copilot/loop';
import { createScriptedModel, SUGGESTED_PROMPTS } from '@/copilot/scripted';
import { DEFAULT_MODEL_ID, MODEL_OPTIONS, hasWebGPU, loadWebLLM } from '@/copilot/webllm';

const promptSchema = toJsonSchema(campaignSchema);
const decoderSchema = toDecoderSchema(promptSchema);
const fields = deriveFields(promptSchema);
const suggestions = SUGGESTED_PROMPTS.map((p) => p.text);

type Tab = 'form' | 'schema' | 'decoder' | 'json';
const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'form', label: 'Form' },
  { id: 'schema', label: 'JSON Schema' },
  { id: 'decoder', label: 'Decoder schema' },
  { id: 'json', label: 'Config JSON' },
];

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const webgpu = useMemo(hasWebGPU, []);
  const [draft, setDraft] = useState<unknown>(defaultCampaign);
  const draftRef = useRef<unknown>(defaultCampaign);
  const [history, setHistory] = useState<unknown[]>([]);
  const [tab, setTab] = useState<Tab>('form');
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set());
  const [changeRevision, setChangeRevision] = useState(0);

  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [engine, setEngine] = useState<EngineState>({ kind: 'idle' });
  const modelRef = useRef<(ModelClient & { unload?: () => Promise<void> }) | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextTurnId = useRef(1);

  const commitDraft = useCallback((next: unknown) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const errors = useMemo(() => validationErrors(campaignSchema, draft), [draft]);
  const valid = errors.size === 0;

  const onFieldChange = useCallback(
    (path: Path, value: unknown) => {
      commitDraft(setAt(draftRef.current, path, value));
      setChanged(new Set());
    },
    [commitDraft],
  );

  const updateTurn = (id: number, update: (t: Turn) => Turn) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? update(t) : t)));

  async function loadModel(): Promise<void> {
    const option = MODEL_OPTIONS.find((m) => m.id === modelId);
    if (option === undefined) return;
    setEngine({ kind: 'loading', progress: { fraction: 0, text: 'Starting…' } });
    try {
      await modelRef.current?.unload?.();
      const model = await loadWebLLM(option, (progress) =>
        setEngine({ kind: 'loading', progress }),
      );
      modelRef.current = model;
      setEngine({ kind: 'ready', label: option.label, scripted: false });
    } catch (error: unknown) {
      modelRef.current = null;
      setEngine({ kind: 'error', message: errorMessage(error) });
    }
  }

  function enableScripted(): void {
    modelRef.current = createScriptedModel();
    setEngine({ kind: 'ready', label: 'Scripted mode', scripted: true });
  }

  async function send(request: string): Promise<void> {
    const model = modelRef.current;
    if (model === null || running) return;
    const id = nextTurnId.current++;
    const snapshot = draftRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setTurns((ts) => [
      ...ts,
      { id, request, status: 'running', attempts: [], changes: [], message: undefined },
    ]);

    try {
      const result = await runCopilot<Campaign>({
        schema: campaignSchema,
        promptSchema,
        decoderSchema,
        crossFieldRules: CROSS_FIELD_RULES,
        current: snapshot as Campaign,
        request,
        model,
        today: localToday(),
        signal: controller.signal,
        onEvent: (event) => {
          switch (event.kind) {
            case 'attempt':
              updateTurn(id, (t) => ({
                ...t,
                attempts: [...t.attempts, { n: event.attempt, text: '', errors: undefined }],
              }));
              break;
            case 'text':
              updateTurn(id, (t) => ({
                ...t,
                attempts: t.attempts.map((a) =>
                  a.n === event.attempt ? { ...a, text: event.text } : a,
                ),
              }));
              break;
            case 'rejected':
              updateTurn(id, (t) => ({
                ...t,
                attempts: t.attempts.map((a) =>
                  a.n === event.attempt ? { ...a, errors: event.errors } : a,
                ),
              }));
              break;
            case 'applied':
              break;
          }
        },
      });

      switch (result.status) {
        case 'applied':
          if (draftRef.current !== snapshot) {
            // Someone edited the form while the model worked; don't overwrite their edit.
            updateTurn(id, (t) => ({
              ...t,
              status: 'failed',
              message:
                "The form changed while the model was working, so this result wasn't applied. Ask again.",
            }));
            break;
          }
          setHistory((h) => [...h, snapshot]);
          commitDraft(result.config);
          setChanged(changedPrefixes(result.changes));
          setChangeRevision((r) => r + 1);
          setTab('form');
          updateTurn(id, (t) => ({ ...t, status: 'applied', changes: result.changes }));
          break;
        case 'unchanged':
          updateTurn(id, (t) => ({
            ...t,
            status: 'unchanged',
            message: 'The model returned the same configuration.',
          }));
          break;
        case 'failed':
          updateTurn(id, (t) => ({
            ...t,
            status: 'failed',
            message: `Still invalid after ${result.attempts} attempts, so nothing was applied.`,
          }));
          break;
        case 'aborted':
          updateTurn(id, (t) => ({ ...t, status: 'aborted' }));
          break;
      }
    } catch (error: unknown) {
      updateTurn(id, (t) => ({ ...t, status: 'error', message: errorMessage(error) }));
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  function undo(): void {
    const previous = history.at(-1);
    if (previous === undefined) return;
    setHistory((h) => h.slice(0, -1));
    commitDraft(previous);
    setChanged(new Set());
  }

  function reset(): void {
    setHistory([]);
    commitDraft(defaultCampaign);
    setChanged(new Set());
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Schema Copilot</h1>
          <p className="text-sm text-muted-foreground">
            One Zod schema generates the form, constrains the model, and validates every edit.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={valid ? 'success' : 'destructive'}>
            {valid ? 'Valid' : `${errors.size} ${errors.size === 1 ? 'error' : 'errors'}`}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            onClick={undo}
            disabled={history.length === 0 || running}
          >
            Undo AI change
          </Button>
          <Button size="sm" variant="ghost" onClick={reset} disabled={running}>
            Reset
          </Button>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_440px]">
        <Card className="flex min-h-0 flex-col">
          <div className="flex gap-1 border-b border-border p-2" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm',
                  tab === t.id ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {tab === 'form' && (
              <div
                className={cn('transition-opacity', running && 'pointer-events-none opacity-60')}
                aria-busy={running}
              >
                {errors.has('') && (
                  <p className="mb-4 rounded-md bg-destructive-soft p-3 text-sm text-destructive">
                    {errors.get('')}
                  </p>
                )}
                <SchemaForm
                  fields={fields}
                  value={draft}
                  onChange={onFieldChange}
                  errors={errors}
                  changed={changed}
                  changeRevision={changeRevision}
                />
              </div>
            )}
            {tab !== 'form' && (
              <>
                <p className="mb-3 text-sm text-muted-foreground">
                  {tab === 'schema' &&
                    'Generated by z.toJSONSchema(). The model sees this in its prompt.'}
                  {tab === 'decoder' &&
                    'The structural subset that constrains decoding: types, enums, required keys. Ranges, patterns and cross-field rules are enforced by Zod after generation.'}
                  {tab === 'json' && 'The live configuration, edited by the form and by the model.'}
                </p>
                <pre className="overflow-auto rounded-md bg-muted p-4 font-mono text-xs leading-relaxed">
                  {JSON.stringify(
                    tab === 'schema' ? promptSchema : tab === 'decoder' ? decoderSchema : draft,
                    null,
                    2,
                  )}
                </pre>
              </>
            )}
          </div>
        </Card>

        <div className="min-h-[560px] lg:min-h-0">
          <ChatPanel
            engine={engine}
            webgpu={webgpu}
            modelId={modelId}
            onModelIdChange={setModelId}
            onLoad={loadModel}
            onUseScripted={enableScripted}
            turns={turns}
            running={running}
            suggestions={suggestions}
            onSend={send}
            onStop={() => abortRef.current?.abort()}
          />
        </div>
      </main>
    </div>
  );
}
