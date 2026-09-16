'use client';

import type { Ref } from 'react';
import { IconUsersGroup } from '@tabler/icons-react';
import Link from 'next/link';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { EmptyState } from '@/shared/state/empty-state';

/**
 * Plain href, never a feature import (rule 13): the agents screen owns the diarization switch.
 * Its grid keeps filters in its own URL codec, so this lands on the Agents list.
 */
const SPEECH_TO_TEXT_AGENTS_HREF = '/agents?task=SPEECH_TO_TEXT';

/**
 * TASK-977 — takes the enrollment wizard's place while the assigned agent has speaker
 * diarization switched off (gateway 409 `ASR_AGENT_DIARIZATION_DISABLED`). Enrolling computes a
 * voice embedding, and voice embedding is off until an admin enables diarization on the agent,
 * so a wizard here could only collect samples for a request the gateway will refuse. `detail`
 * is the gateway's own sentence, which names the agent and the exact switch.
 */
export function EnrollmentBlockedCard({ ref, detail }: { ref?: Ref<HTMLDivElement>; detail?: string }) {
  return (
    <Card ref={ref} tabIndex={-1} className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-medium">Enroll a profile</h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <EmptyState
          icon={IconUsersGroup}
          title="Speaker diarization is off"
          description={
            'Voice profiles are only matched when your speech-to-text agent diarizes speakers, so no voice embedding is computed or stored while it is off. ' +
            'Enable speaker diarization on the agent, then come back to enroll.'
          }
          action={
            <Button asChild variant="outline">
              <Link href={SPEECH_TO_TEXT_AGENTS_HREF}>Open speech-to-text agents</Link>
            </Button>
          }
        />
        {detail ? <p className="text-muted-foreground text-xs">{detail}</p> : null}
      </CardContent>
    </Card>
  );
}
