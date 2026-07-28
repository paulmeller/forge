'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

/**
 * This route (`/api/missions/*`, the pre-v1 surface) reports failures as
 * `{ error: string }`, but its auth gate is the SHARED apiAuth(), which now
 * emits the v1 envelope `{ error: { code, message } }` on 401. Two shapes
 * genuinely reach this one fetch, so read both: rendering the object form
 * directly would crash the component ("Objects are not valid as a React
 * child") precisely when the session expired.
 */
function errorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const { error } = body as { error: unknown };
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error as { message: unknown };
    if (typeof message === 'string') return message;
  }
  return null;
}

export function RequestRetroButton({ missionId }: { missionId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function handleClick() {
    setPending(true);
    setError('');
    try {
      const res = await fetch(`/api/missions/${missionId}/retrospect`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        setError(errorMessage(body) ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <Button onClick={handleClick} disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        Run Retrospective
      </Button>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
