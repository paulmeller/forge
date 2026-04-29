'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import { createSessionFromChat, listSkills, type SkillSummary } from './actions';

type Message = {
  role: 'user' | 'assistant';
  content: string;
  missionId?: string;
};

const MCP_TOOLS = [
  { name: 'GitHub', description: 'PRs, issues, code search', connected: true },
  { name: 'Linear', description: 'Issues and projects', connected: false },
  { name: 'Slack', description: 'Send messages and updates', connected: false },
  { name: 'Google Docs', description: 'Read and edit documents', connected: false },
];

export function ChatInterface() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [selectedModel, setSelectedModel] = useState('opus');
  const [mode, setMode] = useState<'auto' | 'spec'>('auto');
  const [showSkills, setShowSkills] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const skillsRef = useRef<HTMLDivElement>(null);
  const mcpRef = useRef<HTMLDivElement>(null);

  // Load skills on first open
  useEffect(() => {
    if (showSkills && skills.length === 0) {
      listSkills().then(setSkills);
    }
  }, [showSkills, skills.length]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (skillsRef.current && !skillsRef.current.contains(e.target as Node)) {
        setShowSkills(false);
      }
      if (mcpRef.current && !mcpRef.current.contains(e.target as Node)) {
        setShowMcp(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || pending) return;

    const userMessage = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setPending(true);

    try {
      const result = await createSessionFromChat(userMessage, selectedSkill);

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Mission created. Agent dispatched to **${result.repo}**.${selectedSkill ? `\n\nUsing skill: **${selectedSkill}**` : ''}\n\nTracking as [${result.missionName}](/missions/${result.missionId}).`,
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
  const activeSkill = skills.find((s) => s.slug === selectedSkill);

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
              <div key={i} className="mb-6">
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
        {/* Active skill indicator */}
        {activeSkill && (
          <div className="mx-auto mb-2 flex max-w-[720px] items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1 text-[11px] text-primary">
              Skill: {activeSkill.name}
              <button
                onClick={() => setSelectedSkill(null)}
                className="ml-1 hover:text-primary/70"
              >
                x
              </button>
            </span>
          </div>
        )}
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

          {/* MCP dropdown */}
          <div className="relative" ref={mcpRef}>
            <button
              onClick={() => { setShowMcp(!showMcp); setShowSkills(false); }}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition-colors hover:text-foreground ${
                showMcp ? 'border-primary/50 bg-primary/5 text-foreground' : 'bg-muted/50 text-muted-foreground'
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
                {MCP_TOOLS.map((tool) => (
                  <div
                    key={tool.name}
                    className="flex items-center justify-between rounded-md px-2 py-1.5 text-[12px] hover:bg-accent"
                  >
                    <div>
                      <p className="font-medium">{tool.name}</p>
                      <p className="text-[11px] text-muted-foreground">{tool.description}</p>
                    </div>
                    {tool.connected ? (
                      <span className="flex items-center gap-1 text-[10px] text-green-500">
                        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                        On
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground/50">Off</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Skills dropdown */}
          <div className="relative" ref={skillsRef}>
            <button
              onClick={() => { setShowSkills(!showSkills); setShowMcp(false); }}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition-colors hover:text-foreground ${
                showSkills || selectedSkill
                  ? 'border-primary/50 bg-primary/5 text-foreground'
                  : 'bg-muted/50 text-muted-foreground'
              }`}
            >
              Skills{selectedSkill ? ' (1)' : ''}
            </button>
            {showSkills && (
              <div className="absolute bottom-full left-0 mb-2 w-[280px] rounded-lg border bg-background p-2 shadow-lg">
                <p className="mb-2 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Available Skills
                </p>
                {skills.length === 0 ? (
                  <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                    No skills configured yet.
                    <br />
                    <span className="text-[11px]">Add skills in the database to use them here.</span>
                  </p>
                ) : (
                  skills.map((skill) => (
                    <button
                      key={skill.slug}
                      onClick={() => {
                        setSelectedSkill(selectedSkill === skill.slug ? null : skill.slug);
                        setShowSkills(false);
                      }}
                      className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-accent ${
                        selectedSkill === skill.slug ? 'bg-primary/10' : ''
                      }`}
                    >
                      <div>
                        <p className="font-medium">{skill.name}</p>
                        {skill.description && (
                          <p className="text-[11px] text-muted-foreground">{skill.description}</p>
                        )}
                      </div>
                      {selectedSkill === skill.slug && (
                        <span className="text-[10px] text-primary">Active</span>
                      )}
                    </button>
                  ))
                )}
                {/* Built-in document skills hint */}
                <div className="mt-2 border-t pt-2">
                  <p className="px-2 text-[10px] text-muted-foreground/60">
                    Agents also have access to built-in document skills (docx, pdf, xlsx, pptx).
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
