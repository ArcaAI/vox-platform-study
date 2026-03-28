import { cn } from '@/lib/utils';

interface CalloutProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function Callout({ className, children, ...props }: CalloutProps) {
  return (
    <div className={cn('rounded-lg border px-4 py-3 text-sm leading-relaxed [&>p]:m-0', className)} {...props}>
      {children}
    </div>
  );
}
