/**
 * TASK-932 R-16a — `core.agent` declares its DNA writing-style pass with `dna.enabled`.
 *
 * TASK-891 OD-5 says the workflow NAMES the DNA-redaction agent. The `core` vocabulary carries no
 * `agent.dna_style` node type, so the declaration is a flag on the finalizing `core.agent`; the
 * gateway's DNA gate reads it (`ConfigResolver.declaresDna`). Every schema here is
 * `additionalProperties: false`, so an undeclared key would fail publish — this test is what
 * keeps the key declared.
 */
import { describe, expect, it } from 'vitest';

import { NODE_CONFIG_SCHEMAS } from '../node-config-schemas';

describe('TASK-932 — `core.agent` config declares `dna.enabled`', () => {
  it('is a boolean property on a closed object', () => {
    const schema = NODE_CONFIG_SCHEMAS['core.agent'] as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const dna = properties.dna;
    expect(dna).toBeDefined();
    expect(dna.type).toBe('object');
    expect(dna.additionalProperties).toBe(false);
    const enabled = (dna.properties as Record<string, Record<string, unknown>>).enabled;
    expect(enabled.type).toBe('boolean');
  });

  it('only `core.agent` carries it — `core.action` delegates to a catalogue entry instead', () => {
    const action = NODE_CONFIG_SCHEMAS['core.action'] as Record<string, unknown>;
    expect((action.properties as Record<string, unknown>).dna).toBeUndefined();
  });
});
