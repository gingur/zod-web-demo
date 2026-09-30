import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, NativeSelect, Progress, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Change } from '@/copilot/diff';
import { MODEL_OPTIONS, type LoadProgress } from '@/copilot/webllm';

export interface AttemptView {
  n: number;
  text: string;
  errors: string[] | undefined;
}

export type TurnStatus = 'running' | 'applied' | 'unchanged' | 'failed' | 'aborted' | 'error';

export interface Turn {
  id: number;
  request: string;
  status: TurnStatus;
  attempts: AttemptView[];
  changes: Change[];
  message: string | undefined;
}

export type EngineState =
  | { kind: 'idle' }
  | { kind: 'loading'; progress: LoadProgress }
  | { kind: 'ready'; label: string; scripted: boolean }
  | { kind: 'error'; message: string };

interface ChatPanelProps {
  engine: EngineState;
  webgpu: boolean;
  modelId: string;
  onModelIdChange: (id: string) => void;
  onLoad: () => void;
  onUseScripted: () => void;
  turns: readonly Turn[];
  running: boolean;
  suggestions: readonly string[];
  onSend: (text: string) => void;
  onStop: () => void;
}

const fmt = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function ChangeList({ changes }: { changes: readonly Change[] }) {
  return (
    <ul className="grid gap-1 font-mono text-xs">
      {changes.map((c) => (
        <li key={c.path} className="grid grid-cols-[auto_1fr] gap-x-2">
          <span className="text-muted-foreground">{c.path}</span>
          <span>
            <span className="text-destructive line-through decoration-destructive/40">
              {fmt(c.before)}
            </span>
            <span className="text-muted-foreground"> → </span>
            <span className="text-accent">{fmt(c.after)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function AttemptBlock({ attempt, live }: { attempt: AttemptView; live: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (live && ref.current !== null) ref.current.scrollTop = ref.current.scrollHeight;
  }, [attempt.text, live]);
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Attempt {attempt.n}</span>
        {live && <span className="animate-pulse">generating under the schema…</span>}
      </div>
      <pre
        ref={ref}
        className="max-h-28 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-snug text-muted-foreground"
      >
        {attempt.text || ' '}
      </pre>
      {attempt.errors !== undefined && (
        <div className="rounded-md bg-destructive-soft p-2 text-xs text-destructive">
          <p className="mb-1 font-semibold">Rejected by Zod, sent back to the model:</p>
          <ul className="list-disc pl-4">
            {attempt.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const statusBadge: Record<
    TurnStatus,
    { label: string; variant: 'success' | 'destructive' | 'outline' | 'warning' }
  > = {
    running: { label: 'Working', variant: 'outline' },
    applied: {
      label: `Applied after ${turn.attempts.length} ${turn.attempts.length === 1 ? 'attempt' : 'attempts'}`,
      variant: 'success',
    },
    unchanged: { label: 'No changes', variant: 'warning' },
    failed: { label: 'Not applied', variant: 'destructive' },
    aborted: { label: 'Stopped', variant: 'outline' },
    error: { label: 'Error', variant: 'destructive' },
  };
  const badge = statusBadge[turn.status];
  return (
    <div className="grid gap-2">
      <div className="ml-8 justify-self-end rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
        {turn.request}
      </div>
      <div className="mr-4 grid gap-3 rounded-lg rounded-bl-sm border border-border bg-card p-3">
        {turn.attempts.map((a) => (
          <AttemptBlock
            key={a.n}
            attempt={a}
            live={
              turn.status === 'running' && a.n === turn.attempts.length && a.errors === undefined
            }
          />
        ))}
        <div className="flex items-center gap-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        {turn.status === 'applied' && <ChangeList changes={turn.changes} />}
        {turn.message !== undefined && (
          <p className="text-xs text-muted-foreground">{turn.message}</p>
        )}
      </div>
    </div>
  );
}

export function ChatPanel(props: ChatPanelProps) {
  const { engine, turns, running } = props;
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const ready = engine.kind === 'ready';

  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (trimmed === '' || !ready || running) return;
    props.onSend(trimmed);
    setInput('');
  };

  return (
    <Card className="flex h-full min-h-0 flex-col">
      <div className="grid gap-3 border-b border-border p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">Copilot</h2>
            <p className="text-xs text-muted-foreground">
              Runs entirely in your browser. Output is constrained by the schema, then validated by
              Zod.
            </p>
          </div>
          {ready && <Badge variant={engine.scripted ? 'warning' : 'success'}>{engine.label}</Badge>}
        </div>

        {engine.kind !== 'ready' && (
          <div className="grid gap-2">
            {props.webgpu ? (
              <div className="flex gap-2">
                <NativeSelect
                  value={props.modelId}
                  onChange={(e) => props.onModelIdChange(e.target.value)}
                  disabled={engine.kind === 'loading'}
                >
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} · {m.approxDownload}
                    </option>
                  ))}
                </NativeSelect>
                <Button
                  variant="accent"
                  onClick={props.onLoad}
                  disabled={engine.kind === 'loading'}
                >
                  {engine.kind === 'loading' ? 'Loading…' : 'Load'}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-destructive">
                WebGPU isn't available in this browser, so the model can't run here.
              </p>
            )}
            {engine.kind === 'loading' && (
              <div className="grid gap-1">
                <Progress value={engine.progress.fraction} />
                <p className="truncate text-[11px] text-muted-foreground">{engine.progress.text}</p>
              </div>
            )}
            {engine.kind === 'error' && (
              <p className="text-xs text-destructive">{engine.message}</p>
            )}
            <button
              type="button"
              className="justify-self-start text-xs text-muted-foreground underline"
              onClick={props.onUseScripted}
            >
              Use scripted mode instead
            </button>
          </div>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {turns.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Ask for a change in plain language. The model returns a full config, Zod checks it, and
            only a valid result reaches the form.
          </p>
        ) : (
          <div className="grid gap-5">
            {turns.map((t) => (
              <TurnView key={t.id} turn={t} />
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-2 border-t border-border p-4">
        <div className="flex flex-wrap gap-1.5">
          {props.suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={!ready || running}
              onClick={() => send(s)}
              className="rounded-full border border-border px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            placeholder={ready ? 'Describe a change…' : 'Load a model first'}
            disabled={!ready}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          {running ? (
            <Button variant="outline" onClick={props.onStop}>
              Stop
            </Button>
          ) : (
            <Button
              className={cn(!ready && 'opacity-50')}
              disabled={!ready || input.trim() === ''}
              onClick={() => send(input)}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
