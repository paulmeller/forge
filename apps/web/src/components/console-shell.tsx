import { cn } from '@/lib/utils';

export function ConsoleShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <main className={cn('flex h-full flex-col overflow-hidden px-6 py-4', className)}>{children}</main>;
}
