import { GatewayError } from '@/shared/api';

/**
 * BUG-025 — what a failed "Cancel generation" tells the clinician. The gateway answers 404 when the
 * job is already terminal or past the point where the harness accepts a cooperative cancel, so a
 * refusal is explained as the note finishing rather than a generic failure.
 */
export function cancelGenerationErrorMessage(error: unknown): string {
  if (error instanceof GatewayError && error.status === 404) return 'The note is already finishing and can no longer be cancelled.';
  return error instanceof Error && error.message ? error.message : 'Could not cancel the generation';
}
