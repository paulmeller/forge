'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

const MCP_TOOLS = [
  { name: 'GitHub', description: 'PRs, issues, code search', connected: true },
  { name: 'Linear', description: 'Issues and projects', connected: false },
  { name: 'Slack', description: 'Send messages and updates', connected: false },
];

export function ChatInterface() {
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showMcp, setShowMcp] = useState(false);
  const mcpRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });

  const isLoading = status === 'streaming' || status === 'submitted';

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (mcpRef.current && !mcpRef.current.contains(e.target as Node)) {
        setShowMcp(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage({ role: 'user', parts: [{ type: 'text', text: input.trim() }] });
    setInput('');
  }

  const hasMessages = messages.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Chat area */}
      <div className="flex-1 overflow-y-auto" ref={scrollRef}>
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
          <div className="mx-auto w-full max-w-[720px] px-6 py-8">
            {messages.map((msg) => (
              <div key={msg.id} className="mb-6">
                <div className="mb-1 flex items-center gap-2">
                  {msg.role === 'user' ? (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
                      You
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
                  {msg.parts.map((part, i) => {
                    if (part.type === 'text') {
                      return (
                        <div key={i}>
                          {part.text.split('\n').map((line: string, j: number) => (
                            <p key={j} className={j > 0 ? 'mt-1.5' : ''}>
                              {line}
                            </p>
                          ))}
                        </div>
                      );
                    }
                    if (part.type.startsWith('tool-')) {
                      const toolPart = part as { type: string; toolCallId: string; state: string; input?: unknown; output?: unknown };
                      if (toolPart.state === 'input-available' || toolPart.state === 'input-streaming') {
                        return (
                          <div
                            key={i}
                            className="my-2 flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
                          >
                            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                            Working...
                          </div>
                        );
                      }
                      if (toolPart.state === 'output-available') {
                        const result = toolPart.output as Record<string, unknown> | undefined;
                        if (result?.missionUrl) {
                          return (
                            <div key={i} className="my-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => router.push(result.missionUrl as string)}
                              >
                                View Mission
                              </Button>
                            </div>
                          );
                        }
                        return null;
                      }
                    }
                    return null;
                  })}
                </div>
              </div>
            ))}
            {isLoading && messages[messages.length - 1]?.role === 'user' && (
              <div className="mb-6">
                <div className="mb-1 flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                    F
                  </span>
                  <span className="text-xs font-medium">Forge</span>
                </div>
                <div className="pl-8">
                  <span className="inline-block animate-pulse text-sm text-muted-foreground">
                    Thinking...
                  </span>
                </div>
              </div>
            )}
            {error && (
              <div className="mb-6 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {error.message}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Prompt bar */}
      <div className="border-t bg-background px-6 pb-4 pt-3">
        <form onSubmit={handleSubmit} className="w-full">
          <div className="rounded-xl border bg-muted/30">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="What would you like to work on?"
              className="w-full bg-transparent px-4 pb-2 pt-3.5 text-sm outline-none placeholder:text-muted-foreground/50"
              disabled={isLoading}
              autoFocus
            />
            {/* Bottom pills */}
            <div className="flex items-center gap-1.5 px-3 pb-2.5">
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md border bg-muted/50 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
              >
                +
              </button>

              <span className="flex items-center gap-1.5 rounded-md border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground">
                <span className="font-semibold">A\</span>
                <span className="font-medium">Sonnet 4.5</span>
                <span className="flex gap-px">
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className={`inline-block h-2.5 w-[3px] rounded-[1px] ${
                        i < 3 ? 'bg-foreground/40' : 'bg-foreground/10'
                      }`}
                    />
                  ))}
                </span>
              </span>

              <span className="flex items-center gap-1.5 rounded-md border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground">
                Auto
                <span className="flex gap-px">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="inline-block h-2.5 w-[3px] rounded-[1px] bg-foreground/40"
                    />
                  ))}
                </span>
              </span>

              {/* MCP dropdown */}
              <div className="relative" ref={mcpRef}>
                <button
                  type="button"
                  onClick={() => setShowMcp(!showMcp)}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition-colors hover:text-foreground ${
                    showMcp
                      ? 'border-primary/50 bg-primary/5 text-foreground'
                      : 'bg-muted/50 text-muted-foreground'
                  }`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  MCP
                </button>
                {showMcp && (
                  <div className="absolute bottom-full left-0 mb-2 w-[260px] rounded-lg border bg-background p-2 shadow-lg">
                    <p className="mb-2 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                      MCP Connections
                    </p>
                    {MCP_TOOLS.map((t) => (
                      <div
                        key={t.name}
                        className="flex items-center justify-between rounded-md px-2 py-1.5 text-[12px] hover:bg-accent"
                      >
                        <div>
                          <p className="font-medium">{t.name}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {t.description}
                          </p>
                        </div>
                        {t.connected ? (
                          <span className="flex items-center gap-1 text-[10px] text-green-500">
                            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                            On
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground/50">
                            Off
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <span className="flex items-center rounded-md border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground">
                Skills
              </span>

              <div className="flex-1" />

              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md border bg-muted/50 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
              >
                ?
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
