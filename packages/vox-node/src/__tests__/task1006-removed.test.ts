/**
 * TASK-1006 — removes the SYNCHRONOUS consultation-summary generation
 * methods (`generate`, `generatePreSummary`) now that the gateway routes
 * behind them are being retired (lane L-SUM). The async equivalents
 * (`generateAsync`, `generatePreSummaryAsync` + `hope.jobs.waitFor`) are
 * unaffected and remain the only supported way to generate a summary.
 *
 * Response-echo fields that happen to share the `pipelineId` name (e.g.
 * `StreamSessionResponse.pipelineId`, reporting which ASR engine actually
 * served a session) are NOT part of this sweep — only the REQUEST-side
 * `CreateStreamSessionRequest.pipelineId` selector, removed under the same
 * "selection is agentSlug only" rule TASK-865 established for
 * `@arcaai/vox`.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ConsultationSummariesResource } from '../resources/consultation-summaries';

const PACKAGE_ROOT = resolve(__dirname, '..', '..');

describe('the synchronous summary-generation methods are gone (TASK-1006)', () => {
  it('ConsultationSummariesResource carries no .generate / .generatePreSummary methods', () => {
    const proto = ConsultationSummariesResource.prototype as unknown as Record<string, unknown>;
    expect('generate' in proto).toBe(false);
    expect('generatePreSummary' in proto).toBe(false);
  });

  it('keeps the async equivalents intact (not replaced)', () => {
    const proto = ConsultationSummariesResource.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.generateAsync).toBe('function');
    expect(typeof proto.generatePreSummaryAsync).toBe('function');
  });

  it('SYNC_GENERATION_TIMEOUT_MS and GenerateSummaryOptions are no longer exported from the resources barrel', async () => {
    const resources = await import('../resources/index.js');
    expect(resources).not.toHaveProperty('SYNC_GENERATION_TIMEOUT_MS');
    expect(resources).not.toHaveProperty('GenerateSummaryOptions');
  });

  it('SYNC_GENERATION_TIMEOUT_MS and GenerateSummaryOptions are no longer exported from the package root', async () => {
    const root = await import('../index.js');
    expect(root).not.toHaveProperty('SYNC_GENERATION_TIMEOUT_MS');
    expect(root).not.toHaveProperty('GenerateSummaryOptions');
  });
});

describe('pipeline selection is agentSlug-only on the STT streaming request (TASK-1006)', () => {
  // `pipelineId` was a type-only field (TS erases it at build time), so the
  // meaningful check reads the source text directly — the same pattern
  // `summarization-removed.task1004.test.ts` uses for retired call sites.
  it('CreateStreamSessionRequest declares no pipelineId field in src/types/stt.ts', () => {
    const src = readFileSync(join(PACKAGE_ROOT, 'src', 'types', 'stt.ts'), 'utf8');
    const requestBlock = src.slice(src.indexOf('interface CreateStreamSessionRequest'), src.indexOf('interface StreamSessionResponse'));
    expect(requestBlock).not.toMatch(/\bpipelineId\??:/);
    // agentSlug is still there — this proves the slice targeted the right interface.
    expect(requestBlock).toMatch(/\bagentSlug\??:/);
  });

  it('StreamSessionResponse.pipelineId (a server ECHO, not a selector) is unaffected', () => {
    const src = readFileSync(join(PACKAGE_ROOT, 'src', 'types', 'stt.ts'), 'utf8');
    const responseBlock = src.slice(src.indexOf('interface StreamSessionResponse'));
    expect(responseBlock).toMatch(/\bpipelineId\??:/);
  });
});
