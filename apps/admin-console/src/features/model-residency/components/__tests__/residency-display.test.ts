/**
 * TASK-1019 lane Y — a model whose load FAILED renders as words, never as colour
 * alone or a raw enum: "Load failed · <code>", with the message as detail.
 */

import { describe, expect, it } from 'vitest';
import type { ResidencyCatalogueModel } from '../../api/types';
import { formatLoadFailureDetail, formatModelStatus, primaryRowAction } from '../residency-display';

function model(overrides: Partial<ResidencyCatalogueModel>): ResidencyCatalogueModel {
  return {
    aiModelId: 'm1',
    name: 'ArcaAI Whisper ml-en',
    slug: 'arcaai-whisper-ml-en-ggml',
    modelRef: 'arcaai-whisper-ml-en-ggml',
    format: 'WHISPER_CPP',
    status: 'not_loaded',
    size: { bytes: 1_610_612_736, source: 'catalogue' },
    loadSeconds: null,
    residency: null,
    usage: { agentCount: 0, tenantCount: 0, liveConsultation: false, uses: [] },
    keepPolicy: {
      kind: 'on_demand',
      label: 'Load when needed',
      reason: 'Default',
      source: 'default',
      policyId: null,
      policyVersion: null,
      idleTtlSeconds: null,
    },
    actions: ['load', 'edit_policy'],
    ...overrides,
  };
}

describe('formatModelStatus — failed (TASK-1019)', () => {
  it('says "Load failed" with the error code, as text', () => {
    const failed = model({
      status: 'failed',
      error: { code: 'RuntimeError', message: 'no gguf in /models/whisper', at: '2026-09-29T10:00:00Z' },
    });

    expect(formatModelStatus(failed, [])).toBe('Load failed · RuntimeError');
  });

  it('drops the code when it only repeats the sentence (the generic LOAD_FAILED) or is missing', () => {
    const generic = model({ status: 'failed', error: { code: 'LOAD_FAILED', message: 'x', at: null } });
    const bare = model({ status: 'failed', error: null });

    expect(formatModelStatus(generic, [])).toBe('Load failed');
    expect(formatModelStatus(bare, [])).toBe('Load failed');
  });

  it('never falls through to a "Not loaded" sentence', () => {
    expect(formatModelStatus(model({ status: 'failed' }), [])).not.toMatch(/Not loaded/);
  });
});

describe('formatLoadFailureDetail (TASK-1019)', () => {
  it('returns the message for a failed model and nothing otherwise', () => {
    const failed = model({ status: 'failed', error: { code: 'RuntimeError', message: 'no gguf', at: null } });

    expect(formatLoadFailureDetail(failed)).toBe('no gguf');
    expect(formatLoadFailureDetail(model({ status: 'not_loaded' }))).toBeNull();
    expect(formatLoadFailureDetail(model({ status: 'failed', error: null }))).toBeNull();
  });
});

describe('the retry of a failed model is the primary row action', () => {
  it('offers Load when the gateway offers it', () => {
    expect(primaryRowAction(model({ status: 'failed' }).actions)).toBe('load');
  });
});
