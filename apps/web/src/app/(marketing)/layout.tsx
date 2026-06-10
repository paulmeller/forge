import Link from 'next/link';

const GITHUB_URL = 'https://github.com/paulmeller/forge';

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="dark bg-background text-muted-foreground" style={{ colorScheme: 'dark' }}>
      <header className="fixed inset-x-0 top-0 z-50 flex h-16 items-center justify-between bg-background/80 px-6 backdrop-blur-sm sm:px-10">
        <Link href="/" className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-lime-400 shadow-[0_0_8px_2px_rgba(163,230,53,0.6),0_0_20px_4px_rgba(163,230,53,0.3)]" />
          <span className="font-mono text-[15px] font-semibold tracking-tight text-foreground">forge</span>
        </Link>
        <div className="flex items-center gap-5">
          <Link
            href="/docs"
            className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:block"
          >
            Docs
          </Link>
          <Link
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:block"
          >
            GitHub
          </Link>
          <Link
            href="/login"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-all hover:brightness-90"
          >
            Get Started
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
