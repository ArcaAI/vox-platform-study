import { cn } from '@/lib/utils';

export function Main({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <main className={cn('flex grow flex-col overflow-hidden px-4 py-6', className)} {...props} />;
}
