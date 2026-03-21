import { cn } from '@/lib/utils';
import { Card, CardContent } from '@arcaai/ui/card';
import { StatusBadge } from './status-badge';

interface ResourceCardProps {
    name: string;
    subtitle?: string;
    status?: string;
    isSelected?: boolean;
    onClick?: () => void;
    className?: string;
}

export function ResourceCard({
    name,
    subtitle,
    status,
    isSelected,
    onClick,
    className,
}: ResourceCardProps) {
    return (
        <Card
            className={cn(
                'transition-all duration-150',
                onClick && 'cursor-pointer hover:bg-accent/50 active:scale-[0.98]',
                isSelected && 'border-primary bg-primary/5 shadow-sm',
                className,
            )}
            onClick={onClick}
            role={onClick ? 'button' : undefined}
            tabIndex={onClick ? 0 : undefined}
            onKeyDown={
                onClick
                    ? (e: React.KeyboardEvent) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onClick();
                          }
                      }
                    : undefined
            }
        >
            <CardContent className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{name}</p>
                    {subtitle && (
                        <p className="text-muted-foreground truncate text-xs">
                            {subtitle}
                        </p>
                    )}
                </div>
                {status && <StatusBadge status={status} />}
            </CardContent>
        </Card>
    );
}
