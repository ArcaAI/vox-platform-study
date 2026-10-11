/**
 * BUG-025 (secondary) — a refused cancel answered "Could not cancel the generation" plus the
 * gateway's terse 404 text. The gateway refuses (404) when the job is already terminal or past
 * the point where the harness accepts a cooperative cancel, so the console says that plainly.
 */
import { describe, expect, it } from 'vitest';
import { GatewayError } from '@/shared/api';
import { cancelGenerationErrorMessage } from '../cancel-generation-error';

describe('cancelGenerationErrorMessage (BUG-025)', () => {
  it('explains a refused cancel (404) as a note that is already finishing', () => {
    const refused = new GatewayError(404, 'Job not found, already terminal, or not cancellable');
    expect(cancelGenerationErrorMessage(refused)).toBe('The note is already finishing and can no longer be cancelled.');
  });

  it('keeps the gateway message for any other failure', () => {
    expect(cancelGenerationErrorMessage(new GatewayError(503, 'Harness unavailable'))).toBe('Harness unavailable');
  });

  it('falls back to a generic message when there is nothing to show', () => {
    expect(cancelGenerationErrorMessage(undefined)).toBe('Could not cancel the generation');
  });
});
