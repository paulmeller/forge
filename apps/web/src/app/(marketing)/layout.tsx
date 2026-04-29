import Link from 'next/link';

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="dark bg-[#09090b] text-[#fafafa]" style={{ colorScheme: 'dark' }}>
      <nav className="sticky top-0 z-50 flex items-center justify-between border-b border-[#1a1a1e] bg-[#09090b]/85 px-6 py-4 backdrop-blur-sm md:px-12">
        <span className="text-base font-bold tracking-tight">Forge</span>
        <div className="flex items-center gap-6">
          <Link
            href="/docs"
            className="text-[13px] text-[#71717a] transition-colors hover:text-[#a1a1aa]"
          >
            Docs
          </Link>
          <Link
            href="https://github.com/anthropics/forge"
            className="text-[13px] text-[#71717a] transition-colors hover:text-[#a1a1aa]"
          >
            GitHub
          </Link>
          <Link
            href="https://github.com/anthropics/forge"
            className="rounded-md bg-[#fafafa] px-3.5 py-1.5 text-[13px] font-medium text-[#09090b] transition-colors hover:bg-[#e4e4e7]"
          >
            ★ Star
          </Link>
        </div>
      </nav>
      {children}
    </div>
  );
}
