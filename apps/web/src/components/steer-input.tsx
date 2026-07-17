'use client';

import { useState, useTransition } from 'react';

import { Field, FieldError } from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
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
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <Field data-invalid={!!error}>
          <InputGroup>
            <InputGroupInput
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Send an instruction to the running agent…"
              disabled={pending}
              aria-invalid={!!error}
              className="h-8 text-xs"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="submit"
                size="sm"
                variant="outline"
                disabled={pending || !message.trim()}
              >
                {pending ? <Spinner data-icon="inline-start" /> : null}
                Send
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
      </form>
    </div>
  );
}
