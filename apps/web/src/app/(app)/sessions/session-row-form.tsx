'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

import { revokeSessionAction, type RevokeSessionState } from './actions';

const noState: RevokeSessionState = {};

// Keeps the action's plain `(formData) => Promise<State>` signature — the one
// its tests pin — while letting useActionState drive it. Same seam as
// ReviewActionForm and the device consent form.
async function submit(_prev: RevokeSessionState, formData: FormData): Promise<RevokeSessionState> {
  return revokeSessionAction(formData);
}

/**
 * The revoke control for one session.
 *
 * `sessionId` is a database id, not a token. The session token never leaves
 * the server — see lib/sessions.ts for why that constraint is the whole
 * design of this page.
 */
export function SessionRowForm({ sessionId }: { sessionId: string }) {
  const [state, formAction, pending] = useActionState(submit, noState);

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="sessionId" value={sessionId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        Sign out
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
    </form>
  );
}
