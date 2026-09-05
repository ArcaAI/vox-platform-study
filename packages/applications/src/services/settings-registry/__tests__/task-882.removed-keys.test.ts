/**
 * TASK-882 — the pipeline / consultation / harness keys that moved to the workflow, to the
 * SYSTEM `HarnessPolicy` row, or went, are ABSENT from the registry; and the three keys the
 * owner flipped to platform-only stay `globalOnly`.
 */
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

const REMOVED_KEYS = [
  // dead — shadowed by the workflow node's own `enabled` / `agent.dna_redaction`, or routed to a
  // generator that no longer exists
  'pipeline.autoNerEnabled',
  'pipeline.harnessEnabled',
  'pipeline.dnaRedactionEnabled',
  // moved onto the assigned workflow
  'pipeline.autoSummaryEnabled',
  'pipeline.dnaStyleEnabled',
  'agentic.revisit.carryForwardEnabled',
  'consultation.endpoint.actions',
  // no tenant-managed conditions (owner #6)
  'consultation.visitTypes',
  // duplicates of the SUPER_ADMIN_ONLY `HarnessPolicy` columns
  'harness.warmStartEnabled',
  'harness.nerPriorsEnabled',
  'harness.atomicFactEnabled',
] as const;

const PLATFORM_ONLY_KEYS = [
  'text.guardrailPolicy.requireMedical',
  'text.guardrailPolicy.includeReasoning',
  'consultation.realtime.graphExecutor.enabled',
] as const;

describe('TASK-882 — removed keys', () => {
  it.each(REMOVED_KEYS)('%s is not registered', (key) => {
    expect(HOPE_SETTINGS_REGISTRY.has(key)).toBe(false);
  });

  it('the two templateResync keys STAY until the AsrPipeline R4 removal', () => {
    for (const key of ['pipeline.templateResync.enabled', 'pipeline.templateResync.cron']) {
      expect(HOPE_SETTINGS_REGISTRY.has(key), key).toBe(true);
    }
  });
});

describe('TASK-882 — platform-only flips (owner decisions of 2026-09-05)', () => {
  it.each(PLATFORM_ONLY_KEYS)('%s is globalOnly', (key) => {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
    expect(descriptor, key).toBeDefined();
    expect(descriptor?.globalOnly).toBe(true);
  });
});
