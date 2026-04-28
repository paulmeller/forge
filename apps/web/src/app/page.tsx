import Link from 'next/link';

import { Button } from '@/components/ui/button';

export default function Home() {
  return (
    <main className="container flex min-h-screen flex-col items-center justify-center gap-6 py-16">
      <h1 className="text-4xl font-bold tracking-tight">Forge</h1>
      <p className="max-w-xl text-center text-muted-foreground">
        Open-source Missions for Claude Managed Agents. Swap in your own gateway when you need to.
      </p>
      <Button asChild size="lg">
        <Link href="/missions">Open Missions</Link>
      </Button>
    </main>
  );
}
