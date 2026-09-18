/**
 * TASK-985 — `apps/admin-console` hand-MIRRORS every wire type by convention: it
 * takes no dependency on `@arcaai/types`. That convention is deliberate, but for
 * the ASR decode profile it had become a drift generator with nothing behind it.
 *
 * Nothing failed when the canonical type gained a field. Nothing failed when it
 * gained nine. What finally failed was the IMAGE BUILD, and only once a form
 * happened to USE one of them (`hotwordsInPrompt`) — eight others had drifted
 * silently, so the console could not express a decode surface the gateway DTO
 * already validated.
 *
 * This is the missing gate. It compares field NAMES, not shapes: the mirror is
 * allowed to express a type differently (it has no `AiModelAsrProfileRange`), but
 * it may not be missing a member or invent one. A parity failure here is cheap;
 * the same divergence found in `build-admin-console` costs a pipeline.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const CANONICAL = join(ROOT, 'packages/types/src/asr-model-profile.ts');
const MIRROR = join(ROOT, 'apps/admin-console/src/features/ai-models/api/types.ts');

/** Member names of a top-level `type X = {...}` / `interface X {...}` block. */
function members(source: string, name: string): string[] {
  const block = new RegExp(`export (?:type ${name} = |interface ${name} )\\{(.*?)\\n\\}`, 's').exec(source);
  if (!block) throw new Error(`no declaration for ${name}`);
  return [...block[1].matchAll(/^ {2}([a-zA-Z][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]).sort();
}

describe('admin-console mirrors the canonical ASR decode profile', () => {
  const canonical = readFileSync(CANONICAL, 'utf8');
  const mirror = readFileSync(MIRROR, 'utf8');

  for (const type of ['AiModelAsrProfileDecoding', 'AiModelAsrProfileDecodingPass', 'AiModelAsrProfile']) {
    it(`${type} has the same members on both sides`, () => {
      expect(members(mirror, type)).toEqual(members(canonical, type));
    });
  }

  it('every numeric decode knob the mirror declares carries a range', () => {
    // The console validates against its own copied range table. A knob with no
    // bounds is a field an admin can set to anything, which the gateway DTO then
    // rejects — a form that lets you type a value the server refuses.
    const nonNumeric = new Set([
      'conditionOnPrevTokens', 'hotwords', 'hotwordsInPrompt',
      'singleSegment', 'suppressBlank', 'suppressNonSpeechTokens',
      'partial', 'final',
    ]);
    const ranges = new Set(
      [...(/AI_MODEL_ASR_PROFILE_DECODING_RANGES[^=]*=\s*\{(.*?)\n\};/s.exec(mirror)?.[1] ?? '')
        .matchAll(/^ {2}([a-zA-Z][A-Za-z0-9_]*):/gm)].map((m) => m[1]),
    );
    const missing = members(mirror, 'AiModelAsrProfileDecoding').filter(
      (f) => !nonNumeric.has(f) && !ranges.has(f),
    );
    expect(missing).toEqual([]);
  });
});
