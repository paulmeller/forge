import { ConsoleShell } from '@/components/console-shell';
import { listRecentMissions } from '@/lib/recent-missions';
import { withAuth } from '@/lib/with-auth';

import { ChatInterface } from './chat-interface';

export default async function ChatPage() {
  const user = await withAuth();
  const recentMissions = await listRecentMissions(user.id, 2);
  // Chat is a full-height conversation UI, not a document page: it manages its
  // own scroll region and prompt bar padding, so ConsoleShell wraps it with
  // the outer padding zeroed out rather than forcing PageShell's centered
  // document layout.
  return (
    <ConsoleShell className="p-0">
      <ChatInterface recentMissions={recentMissions} />
    </ConsoleShell>
  );
}
