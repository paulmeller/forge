import { withAuth } from '@/lib/with-auth';

import { ChatInterface } from './chat-interface';

export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  await withAuth();

  return <ChatInterface />;
}
