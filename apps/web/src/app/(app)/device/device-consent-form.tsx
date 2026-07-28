'use client';

import { CheckCircle2, ShieldAlert, XCircle } from 'lucide-react';
import { useActionState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

import {
  decideDeviceAction,
  lookupDeviceAction,
  type DeviceDecisionState,
  type DeviceLookupState,
} from './actions';

const noLookup: DeviceLookupState = {};
const noDecision: DeviceDecisionState = {};

// Both actions keep the plain `(formData) => Promise<State>` signature their
// tests pin; these adapters exist only so useActionState can drive them (the
// same seam, and for the same reason, as ReviewActionForm).
async function submitLookup(
  _prev: DeviceLookupState,
  formData: FormData,
): Promise<DeviceLookupState> {
  return lookupDeviceAction(formData);
}

async function submitDecision(
  _prev: DeviceDecisionState,
  formData: FormData,
): Promise<DeviceDecisionState> {
  return decideDeviceAction(formData);
}

/**
 * Two steps, in this order, on purpose:
 *
 *   1. the human types the user code — nothing about the request is shown
 *      before they do, so the page cannot be used to enumerate or preview
 *      someone else's pending authorization;
 *   2. the request is named — which client, what it will get — and only then
 *      are Authorize and Reject offered, on that code.
 *
 * The code carried into step 2 is the one typed in step 1. It is never read
 * from the URL and there is no "the pending one" fallback anywhere in the
 * path: see actions.ts and lib/device-auth.ts.
 */
export function DeviceConsentForm() {
  const [lookup, lookupFormAction, lookingUp] = useActionState(submitLookup, noLookup);
  const [decision, decideFormAction, deciding] = useActionState(submitDecision, noDecision);

  if (decision.decided === 'approve') {
    return (
      <Alert>
        <CheckCircle2 />
        <AlertTitle>Device authorized</AlertTitle>
        <AlertDescription>
          {decision.clientId} can now act as you. Return to your terminal — it should finish signing
          in within a few seconds. You can revoke this at any time by signing out of that session.
        </AlertDescription>
      </Alert>
    );
  }

  if (decision.decided === 'deny') {
    return (
      <Alert>
        <XCircle />
        <AlertTitle>Request rejected</AlertTitle>
        <AlertDescription>
          Nothing was granted. If you did not start this sign-in, no further action is needed.
        </AlertDescription>
      </Alert>
    );
  }

  if (!lookup.request) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Enter your code</CardTitle>
          <CardDescription>
            Type the code exactly as your device is showing it. We ask you to type it — rather than
            filling it in for you — because typing it is what proves this request is yours.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={lookupFormAction} className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="userCode">Device code</Label>
              <Input
                id="userCode"
                name="userCode"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="XXXX-XXXX"
                className="font-mono tracking-[0.3em] uppercase"
                aria-describedby={lookup.error ? 'device-code-error' : undefined}
              />
            </div>
            {lookup.error ? (
              <p id="device-code-error" className="text-xs text-destructive">
                {lookup.error}
              </p>
            ) : null}
            <Button type="submit" disabled={lookingUp} className="self-start">
              {lookingUp ? <Spinner data-icon="inline-start" /> : null}
              Continue
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Authorize {lookup.request.clientId}?</CardTitle>
        <CardDescription>
          Code {lookup.request.userCode} was requested by{' '}
          <span className="font-mono">{lookup.request.clientId}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Alert>
          <ShieldAlert />
          <AlertTitle>This grants full access to your account</AlertTitle>
          <AlertDescription>
            {/*
              Not a placeholder. `/device/token` issues an ordinary session
              token, and Forge rejects any scoped request outright rather than
              echoing a restriction nothing enforces (lib/device-auth.ts), so
              "full access" is the literal truth about what is being granted.
            */}
            {lookup.request.scope
              ? `Requested scope: ${lookup.request.scope}. Scopes are not enforced — this token can do anything you can.`
              : 'Anything you can do in Forge, this device will be able to do, until you sign the session out. Only continue if you started this sign-in yourself.'}
          </AlertDescription>
        </Alert>

        <form action={decideFormAction} className="flex gap-2">
          <input type="hidden" name="userCode" value={lookup.request.userCode} />
          <Button type="submit" name="op" value="approve" disabled={deciding}>
            {deciding ? <Spinner data-icon="inline-start" /> : null}
            Authorize
          </Button>
          <Button type="submit" name="op" value="deny" variant="outline" disabled={deciding}>
            {deciding ? <Spinner data-icon="inline-start" /> : null}
            Reject
          </Button>
        </form>

        {decision.error ? <p className="text-xs text-destructive">{decision.error}</p> : null}
      </CardContent>
    </Card>
  );
}
