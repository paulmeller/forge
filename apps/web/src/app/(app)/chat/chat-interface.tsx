'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { createSessionFromChat } from './actions';

type Message = {
  role: 'user' | 'assistant';
  content: string;
  missionId?: string;
};

export function ChatInterface() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [selectedModel, setSelectedModel] = useState('opus');
  const [mode, setMode] = useState<'auto' | 'spec'>('auto');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || pending) return;

    const userMessage = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setPending(true);

    try {
      const result = await createSessionFromChat(userMessage);

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Mission created. Agent dispatched to **${result.repo}**.\n\nTracking as [${result.missionName}](/missions/${result.missionId}).`,
          missionId: result.missionId,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Error: ${err instanceof Error ? err.message : 'Something went wrong'}`,
        },
      ]);
    } finally {
      setPending(false);
    }
  }

  const hasMessages = messages.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Chat area */}
      <div className="flex-1 overflow-y-auto">
        {!hasMessages ? (
          <div className="flex h-full flex-col items-center justify-center">
            <h1 className="mb-2 text-4xl font-bold tracking-tight text-muted-foreground/20">
              FORGE
            </h1>
            <p className="mb-1 text-sm text-muted-foreground">
              What would you like to work on?
            </p>
            <p className="text-xs text-muted-foreground/60">
              Describe a task. Forge dispatches an agent to do it.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-[720px] px-6 py-8">
            {messages.map((msg, i) => (
              <div key={i} className={`mb-6 ${msg.role === 'user' ? '' : ''}`}>
                <div className="mb-1 flex items-center gap-2">
                  {msg.role === 'user' ? (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
                      PM
                    </span>
                  ) : (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                      F
                    </span>
                  )}
                  <span className="text-xs font-medium">
                    {msg.role === 'user' ? 'You' : 'Forge'}
                  </span>
                </div>
                <div className="pl-8 text-[14px] leading-relaxed text-foreground/90">
                  {msg.content.split('\n').map((line, j) => (
                    <p key={j} className={j > 0 ? 'mt-1.5' : ''}>
                      {line.includes('[') && line.includes('](/') ? (
                        <span
                          dangerouslySetInnerHTML={{
                            __html: line.replace(
                              /\[([^\]]+)\]\(([^)]+)\)/g,
                              '<a href="$2" class="text-primary underline hover:text-primary/80">$1</a>',
                            ),
                          }}
                        />
                      ) : line.includes('**') ? (
                        <span
                          dangerouslySetInnerHTML={{
                            __html: line.replace(
                              /\*\*([^*]+)\*\*/g,
                              '<strong>$1</strong>',
                            ),
                          }}
                        />
                      ) : (
                        line
                      )}
                    </p>
                  ))}
                </div>
                {msg.missionId && (
                  <div className="mt-3 pl-8">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => router.push(`/missions/${msg.missionId}`)}
                    >
                      View Mission
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {pending && (
              <div className="mb-6">
                <div className="mb-1 flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                    F
                  </span>
                  <span className="text-xs font-medium">Forge</span>
                </div>
                <div className="pl-8">
                  <span className="inline-block animate-pulse text-sm text-muted-foreground">
                    Dispatching agent...
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Prompt bar */}
      <div className="border-t bg-background px-4 pb-4 pt-3">
        <form
          onSubmit={handleSubmit}
          className="mx-auto flex max-w-[720px] items-end gap-2"
        >
          <div className="relative flex-1">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="What would you like to work on?"
              className="w-full rounded-lg border bg-muted/50 px-4 py-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary/50 focus:bg-background"
              disabled={pending}
              autoFocus
            />
          </div>
          <Button
            type="submit"
            size="sm"
            className="mb-0.5 h-9 px-4"
            disabled={pending || !input.trim()}
          >
            Send
          </Button>
        </form>
        {/* Bottom pills */}
        <div className="mx-auto mt-2.5 flex max-w-[720px] items-center gap-2">
          <button
            onClick={() => setSelectedModel(selectedModel === 'opus' ? 'sonnet' : 'opus')}
            className="flex items-center gap-1.5 rounded-md border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="font-medium">
              {selectedModel === 'opus' ? 'Opus 4.5' : 'Sonnet 4.5'}
            </span>
            <span className="flex gap-px">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className={`inline-block h-2 w-1.5 rounded-sm ${
                    i < (selectedModel === 'opus' ? 3 : 2)
                      ? 'bg-foreground/40'
                      : 'bg-foreground/10'
                  }`}
                />
              ))}
            </span>
          </button>
          <button
            onClick={() => setMode(mode === 'auto' ? 'spec' : 'auto')}
            className="flex items-center gap-1.5 rounded-md border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {mode === 'auto' ? 'Auto' : 'Spec Mode'}
          </button>
          <button className="flex items-center gap-1.5 rounded-md border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
            MCP
          </button>
          <button className="flex items-center gap-1.5 rounded-md border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
            Skills
          </button>
        </div>
      </div>
    </div>
  );
}
