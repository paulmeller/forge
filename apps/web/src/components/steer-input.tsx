'use client';

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { steerTask } from '@/app/(app)/repos/[owner]/[repo]/actions';

export function SteerInput({ taskId }: { taskId: string }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSend() {
    if (!message.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await steerTask(taskId, message);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage('');
    });
  }

  return (
    <div className="shrink-0">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Send an instruction to the running agent…"
          disabled={pending}
          className="h-8 text-xs"
        />
        <Button type="submit" size="sm" variant="outline" disabled={pending || !message.trim()}>
          {pending ? 'Sending…' : 'Send'}
        </Button>
      </form>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
