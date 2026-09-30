import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, NativeSelect, Progress, Textarea } from '@/components/ui';
import type { Call } from '@/todo/schema';
import { MODEL_OPTIONS, type LoadProgress } from '@/copilot/webllm';
import { ASSISTANT_NAME } from '@/copilot/prompt';

type TurnStatus = 'running' | 'done' | 'failed' | 'aborted' | 'error';

export interface Turn {
  id: number;
  request: string;
  status: TurnStatus;
  /** The assistant's text: streamed while running, then final. */
  reply: string;
  /** The calls that were applied. */
  calls: readonly Call[];
  /** Attempts that failed validation and were sent back to the model. */
  rejected: readonly { attempt: number; errors: readonly string[] }[];
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

function CallLine({ call }: { call: Call }) {
  return (
    <li className="font-mono text-[11px] text-muted-foreground">
      <span className="text-accent">✓ {call.tool}</span> {JSON.stringify(call.args)}
    </li>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <div className="grid gap-2">
      <div className="ml-8 justify-self-end rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
        {turn.request}
      </div>
      <div className="mr-8 grid gap-2 rounded-lg rounded-bl-sm border border-border bg-card px-3 py-2 text-sm">
        <p className={turn.status === 'error' ? 'text-destructive' : undefined}>
          {turn.reply ||
            (turn.status === 'running' ? <span className="animate-pulse">…</span> : '')}
        </p>
        {turn.rejected.map((r) => (
          <div
            key={r.attempt}
            className="rounded-md bg-destructive-soft px-2 py-1 text-xs text-destructive"
          >
            Attempt {r.attempt} rejected by Zod, sent back to the model: {r.errors.join('; ')}
          </div>
        ))}
        {turn.calls.length > 0 && (
          <ul className="grid gap-0.5">
            {turn.calls.map((call, i) => (
              <CallLine key={i} call={call} />
            ))}
          </ul>
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
            <h2 className="text-base font-semibold">{ASSISTANT_NAME}</h2>
            <p className="text-xs text-muted-foreground">
              Runs in your browser. It can do anything the todo list can, and Zod checks every
              change first.
            </p>
          </div>
          {ready && <Badge variant={engine.scripted ? 'warning' : 'success'}>{engine.label}</Badge>}
        </div>

        {engine.kind !== 'ready' && (
          <div className="grid gap-2">
            {props.webgpu ? (
              <div className="flex gap-2">
                <NativeSelect
                  aria-label="Model"
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
              className="justify-self-start text-xs text-muted-foreground underline disabled:opacity-50"
              // A load in flight can't be cancelled, and would overwrite this choice when it lands.
              disabled={engine.kind === 'loading'}
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
            Hi, I'm {ASSISTANT_NAME}. Ask me to add, edit, complete, delete or filter your todos.
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
            aria-label="Message"
            value={input}
            placeholder={ready ? 'Ask for a change…' : 'Load a model first'}
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
            <Button disabled={!ready || input.trim() === ''} onClick={() => send(input)}>
              Send
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
