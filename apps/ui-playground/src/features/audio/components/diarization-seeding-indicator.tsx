import { Badge } from '@arcaai/ui/badge';
import { Fingerprint, Info } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

export interface DiarizationSeedingIndicatorProps {
  /**
   * Backend preseed echo for the active streaming session
   * (`StreamingSessionResponse.voiceProfileSeeded`):
   * - `true`  — the caller's enrolled voice profile seeded diarization
   * - `false` — diarization ran without personalization
   * - `null`  — no session yet (or an older API omitted the field)
   */
  seeded: boolean | null;
}

/**
 * TASK-329 P4 / D-3 — surfaces the diarization voice-profile seeding signal.
 *
 * When the backend reports that the caller's enrolled voice profile was used to
 * seed diarization we show a clear positive Badge and fire a one-time success
 * toast. When diarization ran without personalization we show a quiet neutral
 * note instead. Nothing is rendered until a session reports a value.
 */
export function DiarizationSeedingIndicator({ seeded }: DiarizationSeedingIndicatorProps) {
  // Announce the positive signal once per seeded session, not on every render.
  const announcedRef = useRef(false);

  useEffect(() => {
    if (seeded === true) {
      if (!announcedRef.current) {
        announcedRef.current = true;
        toast.success('Voice profile seeded into diarization');
      }
    } else {
      announcedRef.current = false;
    }
  }, [seeded]);

  if (seeded == null) return null;

  return seeded ? (
    <Badge variant="default" className="gap-1 text-[10px]">
      <Fingerprint className="size-2.5" />
      Voice profile seeded
    </Badge>
  ) : (
    <Badge variant="secondary" className="gap-1 text-[10px]">
      <Info className="size-2.5" />
      Diarization not personalized
    </Badge>
  );
}
