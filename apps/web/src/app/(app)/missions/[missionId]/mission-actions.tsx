'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

import { missionAction, type MissionActionState } from './actions';

const initial: MissionActionState = {};

type ButtonConfig = {
  label: string;
  variant?: 'default' | 'secondary' | 'outline' | 'destructive';
  op: 'plan' | 'start' | 'pause' | 'resume';
};

export function MissionActionButton({
  missionId,
  op,
  label,
  variant = 'default',
  disabled,
  disabledReason,
}: {
  missionId: string;
  disabled?: boolean;
  disabledReason?: string;
} & ButtonConfig) {
  const [state, formAction, pending] = useActionState(missionAction, initial);

  return (
    <div className="flex items-center gap-3">
      <form action={formAction}>
        <input type="hidden" name="missionId" value={missionId} />
        <input type="hidden" name="op" value={op} />
        <Button type="submit" variant={variant} disabled={pending || disabled}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          {label}
        </Button>
      </form>
      {state.error ? (
        <span className="text-xs text-destructive">{state.error}</span>
      ) : disabled && disabledReason ? (
        <span className="text-xs text-muted-foreground">{disabledReason}</span>
      ) : null}
    </div>
  );
}
