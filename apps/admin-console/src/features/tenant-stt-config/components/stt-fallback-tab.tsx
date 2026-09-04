'use client';

import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle, Button } from '@arcaai/ui';

/**
 * @deprecated TASK-861 — removed in R4 with `TenantSttConfig`.
 *
 * The tenant-wide STT fallback pointer (`fallbackPipelineId` + auto-switch) is
 * RETIRED: the fallback engine is now a property of the ASR Agent
 * (`parameters.fallback` — a fallback agent or the agent's own model chain),
 * resolved per session by the gateway. The Speech tab of `/ai-configuration`
 * keeps rendering for the window so bookmarks land somewhere useful, but it no
 * longer edits anything — it points at the replacement.
 */
export function SttFallbackTab() {
  return (
    <div className="flex flex-col gap-4 py-4">
      <h2 className="text-base font-semibold">Speech fallback moved to the ASR agent</h2>
      <Alert>
        <AlertTitle>Retired (TASK-861 — removed in R4)</AlertTitle>
        <AlertDescription>
          The tenant-wide fallback pipeline and auto-switch settings are retired. Configure the fallback engine on the transcription
          agent instead: open the agent, then edit its <span className="font-mono">fallback</span> block (a fallback agent, or the
          model chain) and the auto-switch threshold. The gateway resolves it per session.
        </AlertDescription>
      </Alert>
      <div className="flex gap-2">
        <Button asChild>
          <Link href="/agents?task=SPEECH_TO_TEXT">Open transcription agents</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/workflow-studio/assignments">Agent assignments</Link>
        </Button>
      </div>
    </div>
  );
}
