/**
 * @arcaai/noise-filter - Worklet source drift guard
 *
 * The RNNoise worklet processor logic exists in three hand-maintained copies
 * that must stay algorithmically identical:
 *
 *   1. src/worklets/rnnoise.worklet.ts            — the TS AudioWorkletProcessor
 *   2. src/worklets/worklet-loader.ts             — the same logic re-embedded as
 *                                                   an inline blob string
 *   3. src/processors/workletRnnoiseLoader.ts     — the WASM-instantiation subset
 *
 * All three encode a hard dependency on `@jitsi/rnnoise-wasm`'s minified export
 * names and its `{ a: { a: resize_heap, b: memcpy_big } }` import object. An edit
 * to one copy that is not mirrored to the others compiles and passes the existing
 * export-shape tests, but fails only at runtime in the browser. This suite is the
 * automated guard that closes that gap until the three are unified into one source.
 *
 * A naive line-by-line diff is deliberately NOT used: the two full-processor
 * copies legitimately differ in surface syntax (TS type annotations / access
 * modifiers, `wasmExports` vs `exports`, `performance.now()` vs the worklet-global
 * `currentTime`). Instead this suite pins the load-bearing invariants — the WASM
 * ABI contract, the import-object shape, the DSP constants, and the core
 * frame-processing body — and asserts they agree across the copies.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKLET_TS = fileURLToPath(import.meta.resolve('../worklets/rnnoise.worklet.ts'));
const LOADER_TS = fileURLToPath(import.meta.resolve('../worklets/worklet-loader.ts'));
const WASM_LOADER_TS = fileURLToPath(import.meta.resolve('../processors/workletRnnoiseLoader.ts'));

const readSource = (path: string): string => readFileSync(path, 'utf8');

/** Strip `//` line and block comments so doc-comment prose never matches code regexes. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Normalize a source so the two full-processor copies compare equal on their
 * WASM-facing code: unify the exports accessor name and drop TS-only tokens.
 */
function normalizeForAbi(src: string): string {
  return stripComments(src).replace(/\bwasmExports\b/g, 'exports').replace(/\bthis\./g, '');
}

/** Extract the inline worklet blob returned by `generateWorkletSource()`. */
function extractInlineWorkletSource(loaderSrc: string): string {
  const match = loaderSrc.match(
    /function generateWorkletSource\(\)\s*:\s*string\s*\{\s*return\s*`([\s\S]*?)`;/,
  );
  if (!match) throw new Error('Could not locate generateWorkletSource() template literal');
  return match[1];
}

type AbiMap = {
  memory: string;
  callCtors: string;
  create: string;
  malloc: string;
  destroy: string;
  free: string;
  processFrame: string;
};

/**
 * Extract the `@jitsi/rnnoise-wasm` export letter used for each ABI role. Each
 * role is anchored to a semantic call site (present in either the full-processor
 * form or the loader-module form), so a swapped letter — e.g. malloc/free — is
 * caught, not just a missing one.
 */
function extractAbi(normalizedSrc: string): AbiMap {
  const first = (patterns: RegExp[], role: string): string => {
    for (const re of patterns) {
      const m = normalizedSrc.match(re);
      if (m) return m[1];
    }
    throw new Error(`Could not extract ABI export letter for role "${role}"`);
  };

  return {
    memory: first([/memory\s*(?::\s*[\w.]+)?\s*=\s*exports\.([a-j])\b/], 'memory'),
    callCtors: first([/refreshViews\(\)\s*;\s*exports\.([a-j])\(\)/], 'callCtors'),
    create: first(
      [/denoiseState\s*=\s*exports\.([a-j])\(\)/, /rnnoise_create:\s*\(\)\s*=>\s*exports\.([a-j])\(/],
      'create',
    ),
    malloc: first(
      [/(?:input|output)Ptr\s*=\s*exports\.([a-j])\(/, /malloc:\s*\(size\)\s*=>\s*exports\.([a-j])\(/],
      'malloc',
    ),
    destroy: first(
      [/exports\.([a-j])\(denoiseState\)/, /rnnoise_destroy:\s*\(state\)\s*=>\s*exports\.([a-j])\(/],
      'destroy',
    ),
    free: first(
      [/exports\.([a-j])\((?:input|output)Ptr\)/, /free:\s*\(ptr\)\s*=>\s*exports\.([a-j])\(/],
      'free',
    ),
    processFrame: first(
      [
        /exports\.([a-j])\(denoiseState,\s*outputPtr,\s*inputPtr\)/,
        /rnnoise_process_frame:\s*\([^)]*\)\s*=>\s*exports\.([a-j])\(/,
      ],
      'processFrame',
    ),
  };
}

/**
 * Extract the resize/memcpy identifiers bound in the `{ a: { a, b } }` import
 * object. Ordering is ABI-critical: inner `a` is the heap-resize import, inner
 * `b` is the memcpy import.
 */
function extractImportObject(normalizedSrc: string): { resize: string; memcpy: string } {
  const m = normalizedSrc.match(/\{\s*a:\s*\{\s*a:\s*(\w+)\s*,\s*b:\s*(\w+)\s*,?\s*\}\s*,?\s*\}/);
  if (!m) throw new Error('Could not locate { a: { a, b } } import object');
  return { resize: m[1], memcpy: m[2] };
}

/** Extract a brace-balanced function/method body starting at a header match. */
function extractBlock(src: string, headerRe: RegExp): string {
  const clean = stripComments(src);
  const header = clean.match(headerRe);
  if (!header || header.index === undefined) {
    throw new Error(`Could not locate block header ${headerRe}`);
  }
  const open = clean.indexOf('{', header.index + header[0].length - 1);
  if (open === -1) throw new Error(`No opening brace after ${headerRe}`);
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}' && --depth === 0) return clean.slice(open + 1, i);
  }
  throw new Error(`Unbalanced braces after ${headerRe}`);
}

/** Reduce a body to its algorithm: unify the exports name, drop TS-only tokens and whitespace. */
function normalizeBody(body: string): string {
  return body
    .replace(/\bwasmExports\b/g, 'exports')
    .replace(/\bthis\./g, '')
    .replace(/!/g, '')
    .replace(/\s+/g, '');
}

/** The canonical `@jitsi/rnnoise-wasm@0.2.1` ABI all three copies must encode. */
const EXPECTED_ABI: AbiMap = {
  memory: 'c',
  callCtors: 'd',
  create: 'f',
  malloc: 'g',
  destroy: 'h',
  free: 'i',
  processFrame: 'j',
};

const worklet = readSource(WORKLET_TS);
const loader = readSource(LOADER_TS);
const wasmLoader = readSource(WASM_LOADER_TS);
const inlineSource = extractInlineWorkletSource(loader);

const abiSources: Array<[string, string]> = [
  ['rnnoise.worklet.ts', worklet],
  ['worklet-loader.ts (inline blob)', inlineSource],
  ['workletRnnoiseLoader.ts', wasmLoader],
];

describe('worklet source drift — WASM ABI contract parity', () => {
  it.each(abiSources)('%s pins the expected rnnoise-wasm export ABI', (_label, src) => {
    expect(extractAbi(normalizeForAbi(src))).toEqual(EXPECTED_ABI);
  });

  it('all three copies agree on the ABI (no un-mirrored export-name edit)', () => {
    const maps = abiSources.map(([, src]) => extractAbi(normalizeForAbi(src)));
    for (const map of maps) expect(map).toEqual(maps[0]);
  });

  it.each(abiSources)('%s uses the { a: { a: resize, b: memcpy } } import object', (_label, src) => {
    const normalized = normalizeForAbi(src);
    const { resize, memcpy } = extractImportObject(normalized);
    // Inner `a` must be the heap-resize import (calls memory.grow); inner `b` the memcpy (copyWithin).
    expect(new RegExp(`${resize}\\b[\\s\\S]{0,400}?\\.grow\\(`).test(normalized)).toBe(true);
    expect(new RegExp(`${memcpy}\\b[\\s\\S]{0,400}?\\.copyWithin\\(`).test(normalized)).toBe(true);
  });
});

describe('worklet source drift — full-processor algorithm parity (inline blob ↔ rnnoise.worklet.ts)', () => {
  const frameSize = (src: string): string => {
    const m = src.match(/RNNOISE_FRAME_SIZE\s*=\s*(\d+)/);
    if (!m) throw new Error('RNNOISE_FRAME_SIZE not found');
    return m[1];
  };

  const levelMultipliers = (src: string): string => {
    const m = stripComments(src).match(/LEVEL_MULTIPLIERS[^=]*=\s*\{([^}]*)\}/);
    if (!m) throw new Error('LEVEL_MULTIPLIERS not found');
    return m[1].replace(/\s+/g, '').replace(/,$/, '');
  };

  it('share RNNOISE_FRAME_SIZE', () => {
    expect(frameSize(inlineSource)).toBe(frameSize(worklet));
    expect(frameSize(worklet)).toBe('480');
  });

  it('share the LEVEL_MULTIPLIERS mix table', () => {
    expect(levelMultipliers(inlineSource)).toBe(levelMultipliers(worklet));
    expect(levelMultipliers(worklet)).toBe('low:0.5,medium:0.75,high:1.0');
  });

  it('share a two-frame output ring buffer (one-frame priming latency)', () => {
    expect(inlineSource).toMatch(/outputRingCapacity\s*=\s*RNNOISE_FRAME_SIZE\s*\*\s*2/);
    expect(worklet).toMatch(/outputRingCapacity\s*=\s*RNNOISE_FRAME_SIZE\s*\*\s*2/);
  });

  it('share an identical frame-processing DSP body', () => {
    // Anchor to the method DEFINITION (`) {`), not the earlier `this.processFrame()` call site.
    const inlineBody = extractBlock(inlineSource, /\bprocessFrame\s*\([^)]*\)\s*\{/);
    const workletBody = extractBlock(worklet, /\bprocessRNNoiseFrame\s*\([^)]*\)\s*(?::\s*void\s*)?\{/);
    expect(normalizeBody(inlineBody)).toBe(normalizeBody(workletBody));
  });

  it('register the same processor name', () => {
    const name = /registerProcessor\(\s*['"]([^'"]+)['"]/;
    expect(inlineSource.match(name)?.[1]).toBe(worklet.match(name)?.[1]);
    expect(worklet.match(name)?.[1]).toBe('rnnoise-worklet-processor');
  });
});
