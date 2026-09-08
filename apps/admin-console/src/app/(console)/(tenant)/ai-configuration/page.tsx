import { redirect } from 'next/navigation';

/**
 * `/ai-configuration` ("Speech & Voice") → `/agents?task=SPEECH_TO_TEXT`.
 *
 * TASK-932 §3.1: the nav entry is removed entirely (not just re-tiered) —
 * pre-production posture, a redundant old-architecture surface is retired
 * outright rather than dual-homed (TASK-888 precedent). The remaining binding
 * (`TenantSttConfig`'s fallback pointer) retires with the ASR Agent, which is
 * exactly what `/agents?task=SPEECH_TO_TEXT` already surfaces — the same
 * target `/audio/pipelines`' own retirement redirect uses.
 *
 * Kept for ONE release so bookmarks and deep links keep working. Delete this
 * folder in the release after the one that ships this redirect.
 */
export default function AiConfigurationRedirectPage(): never {
  redirect('/agents?task=SPEECH_TO_TEXT');
}
