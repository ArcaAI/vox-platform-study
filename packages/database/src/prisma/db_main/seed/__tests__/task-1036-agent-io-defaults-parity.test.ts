/**
 * TASK-1036 (OD-8, contract freeze) — the seeded agents' compiled I/O schemas are the contract's
 * CURRENT defaults, not an older hand copy.
 *
 * `25-agents.ts` compiles `AGENT_IO_DEFAULTS` into every seeded agent's `compiledConfig` so the
 * runtime never reads a null schema. This package takes no dependency on the contract, so the
 * table is a copy — and a copy had drifted twice: the TEXT input still said `required: ['text']`
 * (OD-8 made the turn `message`, with `text` a deprecated alias and a `variables`-only body
 * valid), and the ASR output still declared `transcript` as an ARRAY, the shape the contract
 * retired for `transcript` TEXT + `segments`. This file fails on any such drift.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { GLOBAL_AGENT_SPECS, IO_DEFAULTS, PLATFORM_AGENT_SPECS, buildCompiledConfig, type SeedModelRef } from '../25-agents';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { AGENT_IO_DEFAULTS } = contract;

/** The contract's tables are frozen objects; the seed's are plain — compare by JSON value. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('the seed`s task I/O defaults equal the contract`s AGENT_IO_DEFAULTS', () => {
  it.each(['TEXT_GENERATION', 'SPEECH_TO_TEXT', 'TEXT_TO_SPEECH'] as const)('%s: input and output schemas are identical', (task) => {
    expect(plain(IO_DEFAULTS[task].inputSchema)).toEqual(plain(AGENT_IO_DEFAULTS[task].inputSchema));
    expect(plain(IO_DEFAULTS[task].outputSchema)).toEqual(plain(AGENT_IO_DEFAULTS[task].outputSchema));
  });

  it('TEXT input is `message` (OD-8): `text` stays a deprecated alias and a variables-only body is valid', () => {
    const schema = IO_DEFAULTS.TEXT_GENERATION.inputSchema as { required?: string[]; properties: Record<string, { deprecated?: boolean }> };
    expect(schema.required).toBeUndefined();
    expect(Object.keys(schema.properties)).toEqual(['message', 'text', 'variables']);
    expect(schema.properties.text?.deprecated).toBe(true);
  });

  it('ASR output has `transcript` as TEXT and the structure on `segments` — the retired transcript array is gone', () => {
    const schema = IO_DEFAULTS.SPEECH_TO_TEXT.outputSchema as { properties: Record<string, { type?: string }> };
    expect(schema.properties.transcript?.type).toBe('string');
    expect(schema.properties.segments?.type).toBe('array');
  });

  it('the NER default is unchanged by this lane: it stays the INTERFACES section 2.3 literal pinned in task-930-agents.test.ts', () => {
    expect(IO_DEFAULTS.NAMED_ENTITY_RECOGNITION.outputSchema).toHaveProperty('required', ['entities']);
  });
});

describe('every seeded agent compiles to those defaults', () => {
  const model = (slug: string): SeedModelRef => ({ id: `model-${slug}`, slug, taskType: 'X', provider: null, wireModelId: null });
  it.each(
    [...PLATFORM_AGENT_SPECS, ...GLOBAL_AGENT_SPECS]
      .filter((spec) => spec.task !== 'NAMED_ENTITY_RECOGNITION' && !spec.outputSchema)
      .map((spec) => [spec.tenantId.slice(0, 8) + '/' + spec.slug, spec] as const),
  )('%s: compiled input/output schema is the task default', (_label, spec) => {
    const compiled = buildCompiledConfig(spec, model(spec.modelSlug), spec.fallbackModelSlugs.map(model), null) as unknown as {
      inputSchema: unknown;
      outputSchema: unknown;
    };
    expect(plain(compiled.inputSchema)).toEqual(plain(AGENT_IO_DEFAULTS[spec.task].inputSchema));
    expect(plain(compiled.outputSchema)).toEqual(plain(AGENT_IO_DEFAULTS[spec.task].outputSchema));
  });
});
