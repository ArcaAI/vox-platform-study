'use client';

/**
 * A registry-declared safety class as a `Badge` (TASK-719 Task 12). Rule 11 §7: badge variants
 * carry the WORD, never color alone. `'mandatory'` renders `destructive` (cannot be removed
 * from the graph); every other class renders `outline` (neutral, informational).
 */
import { Badge } from '@arcaai/ui';

export function SafetyClassBadge({ className }: { className: string }) {
  return (
    <Badge variant={className === 'mandatory' ? 'destructive' : 'outline'} className="text-xs">
      {className}
    </Badge>
  );
}
