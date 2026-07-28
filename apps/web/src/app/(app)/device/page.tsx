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
 * there: a code arriving in a URL is a code the human did not type, and the
 * typing is the only evidence that the person approving is the person who
 * started the flow on the device. Adding a `searchParams` prop to "improve the
 * UX" would hand back the phishing path this page exists to close.
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
