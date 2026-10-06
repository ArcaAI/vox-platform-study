'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui';
import type { AsrDegradation } from '../api/asr-degradation';

/**
 * TASK-1048 — persistent notice above a transcript: which optional stages are off for THIS
 * session. `role="status"` (polite), icon + words (never colour alone). Renders nothing when empty.
 */
export function AsrDegradationBanner({ items }: { items: readonly AsrDegradation[] }) {
  if (items.length === 0) return null;
  return (
    <Alert role="status" className="[&>svg]:text-warning" data-testid="asr-degradation-banner">
      <IconAlertTriangle aria-hidden />
      <AlertTitle>Some optional processing is off for this session</AlertTitle>
      <AlertDescription>
        <p>Transcription is still running.</p>
        <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
          {items.map((item) => (
            <li key={item.key}>
              {item.label}
              {item.detail ? <span className="text-muted-foreground"> — {item.detail}</span> : null}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
