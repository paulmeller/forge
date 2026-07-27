'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

import { reviewAction, type ReviewActionState } from './review-actions';

const initial: ReviewActionState = {};

// reviewAction's signature (formData) => Promise<ReviewActionState> is the
// tested contract other callers (and review-actions.test.ts) depend on —
// don't change it to fit useActionState's (prevState, formData) shape.
// This adapter is the seam instead: it exists only so a plain <form
// action={async (fd) => { 'use server'; await reviewAction(fd); }}
// (the previous wiring) doesn't silently discard the returned { error }.
// That wiring meant a human clicking Approve on a task that raced out from
// under them (see the CAS lost-race branch in review-actions.ts) got total
// silence — no message, and revalidatePath only fires on the success path,
// so the page might not even re-render.
async function submitReview(
  _prevState: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  return reviewAction(formData);
}

export function ReviewActionForm({ taskId }: { taskId: string }) {
  const [state, formAction, pending] = useActionState(submitReview, initial);

  return (
    <div className="mt-3 flex flex-col gap-2">
      <form action={formAction} className="flex gap-2">
        <input type="hidden" name="taskId" value={taskId} />
        <Button type="submit" name="op" value="approve" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Approve
        </Button>
        <Button type="submit" name="op" value="dismiss" variant="outline" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Dismiss
        </Button>
      </form>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
    </div>
  );
}
