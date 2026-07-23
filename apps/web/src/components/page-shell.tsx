import { cn } from '@/lib/utils';

export function PageShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <main className={cn('w-full px-6 py-8', className)}>{children}</main>;
}

export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="title-glow mb-8 flex items-start justify-between gap-4">
      <div>
        <h1 className="font-title text-3xl uppercase tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-start gap-2">{actions}</div> : null}
    </div>
  );
}
