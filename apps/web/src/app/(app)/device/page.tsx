import { PageHeader, PageShell } from '@/components/page-shell';
import { withAuth } from '@/lib/with-auth';

import { DeviceConsentForm } from './device-consent-form';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Authorize a device',
};

/**
 * The consent page the device-authorization flow's `verification_uri` points
 * at — the page whose absence was one of the three reasons the plugin stayed
 * unregistered (see lib/auth.ts).
 *
 * `withAuth()` redirects to /login when there is no session, so an
 * unauthenticated visitor can never reach the form.
 *
 * This component takes NO props. In particular it does not read
 * `searchParams`, even though `verification_uri_complete` puts the user code
 * there. Adding a `searchParams` prop to "improve the UX" would pre-fill the
 * field from the URL, and a pre-filled field turns approval into one click on
 * a screen nobody read — the whole consent step collapses into following a
 * link.
 *
 * Be exact about what that buys, because the looser version of this sentence
 * ("typing is the only evidence that the person approving is the person who
 * started the flow") is false and used to be written here. Typing the code
 * proves the human KNOWS the code. Whoever generated it knows it too and can
 * simply tell them — `/device/code` needs no authentication, and a message
 * saying "go to <this exact site>/device and enter ABCD-2345" defeats nothing
 * on this page. That is RFC 8628 §5.1 remote phishing and it is inherent to
 * the device grant; see the note beside `plugins:` in lib/auth.ts, and
 * /sessions for the mitigation that does apply — every session this flow
 * issues is listed there and revocable.
 *
 * So: no prefill closes the one-click path, which is real. It does not close
 * the social-engineering path, which nothing here can.
 */
export default async function DevicePage() {
  await withAuth();

  return (
    <PageShell className="max-w-xl py-10">
      <PageHeader
        title="Authorize a device"
        subtitle="A device or command-line tool is asking to sign in as you. Enter the code it is showing to continue."
      />
      <DeviceConsentForm />
    </PageShell>
  );
}
