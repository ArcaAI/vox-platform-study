/**
 * Pure content-addressed version derivation for the `hope-models` bucket
 * layout — see `infrastructure/docker/minio/README.md` §5.2.
 *
 * These are the two live bucket examples the orchestrator provided as the
 * source of truth for the naming convention:
 *   gemma-4-e2b-it-qat-gguf/q4-0-451faffb5a16
 *   granite-guardian-4.1-8b-gguf/q4-k-m-1af04917c451
 * i.e. `<quant-token>-<first 12 hex chars of sha256(SHA256SUMS content)>`,
 * where the quant token is the lowercase, hyphenated GGUF quantization
 * string (`Q4_0` -> `q4-0`, `Q4_K_M` -> `q4-k-m`).
 */
import { describe, expect, it } from 'vitest';
import {
  buildSha256SumsContent,
  deriveModelVersion,
  deriveQuantTokenFromFilenames,
  isRelevantModelSourceFile,
  normalizeQuantToken,
  sha256Hex,
} from '../model-version.util';

describe('normalizeQuantToken', () => {
  it('lowercases and hyphenates a GGUF quant string', () => {
    expect(normalizeQuantToken('Q4_0')).toBe('q4-0');
    expect(normalizeQuantToken('Q4_K_M')).toBe('q4-k-m');
    expect(normalizeQuantToken('q8_0')).toBe('q8-0');
  });

  it('trims stray separators', () => {
    expect(normalizeQuantToken('  Q4_0  ')).toBe('q4-0');
    expect(normalizeQuantToken('-Q4_0-')).toBe('q4-0');
  });
});

describe('deriveQuantTokenFromFilenames', () => {
  it('extracts a quant token from a filename that embeds one', () => {
    expect(deriveQuantTokenFromFilenames(['gemma-4-E2B_q4_0-it.gguf'])).toBe('q4-0');
    expect(deriveQuantTokenFromFilenames(['granite-guardian-4.1-8b-Q4_K_M.gguf'])).toBe('q4-k-m');
  });

  it('tries candidates in order and returns the first match', () => {
    expect(deriveQuantTokenFromFilenames(['config.json', 'model-Q5_K_M.gguf'])).toBe('q5-k-m');
  });

  it('returns null when no candidate carries a recognizable quant token', () => {
    expect(deriveQuantTokenFromFilenames(['config.json', 'tokenizer.json'])).toBeNull();
  });
});

describe('isRelevantModelSourceFile', () => {
  it('accepts GGUF weight and companion projector files', () => {
    expect(isRelevantModelSourceFile('gemma-4-E2B_q4_0-it.gguf')).toBe(true);
    expect(isRelevantModelSourceFile('subdir/gemma-4-E2B-it-mmproj.gguf')).toBe(true);
  });

  it('accepts the known tokenizer/config companion files', () => {
    expect(isRelevantModelSourceFile('config.json')).toBe(true);
    expect(isRelevantModelSourceFile('tokenizer.json')).toBe(true);
    expect(isRelevantModelSourceFile('tokenizer_config.json')).toBe(true);
    expect(isRelevantModelSourceFile('vocab.json')).toBe(true);
    expect(isRelevantModelSourceFile('merges.txt')).toBe(true);
  });

  it('rejects everything else (README, license, git metadata)', () => {
    expect(isRelevantModelSourceFile('README.md')).toBe(false);
    expect(isRelevantModelSourceFile('.gitattributes')).toBe(false);
    expect(isRelevantModelSourceFile('LICENSE')).toBe(false);
  });
});

describe('buildSha256SumsContent', () => {
  it('renders one `<sha256>  <path>` line per file, matching `shasum -a 256` output', () => {
    const content = buildSha256SumsContent([
      { path: 'a.gguf', sha256: 'aaa' },
      { path: 'config.json', sha256: 'bbb' },
    ]);
    expect(content).toBe('aaa  a.gguf\nbbb  config.json\n');
  });

  it('is empty-but-newline-terminated for no files (defensive; callers should never pass an empty list)', () => {
    expect(buildSha256SumsContent([])).toBe('\n');
  });
});

describe('sha256Hex', () => {
  it('matches the known sha256 of an empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the known sha256 of "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes a Buffer identically to the equivalent utf8 string', () => {
    expect(sha256Hex(Buffer.from('abc', 'utf8'))).toBe(sha256Hex('abc'));
  });
});

describe('deriveModelVersion', () => {
  it('prefixes the content hash with the quant token when one is known', () => {
    const sums = buildSha256SumsContent([{ path: 'a.gguf', sha256: 'aaa' }]);
    const version = deriveModelVersion('q4-0', sums);
    expect(version).toBe(`q4-0-${sha256Hex(sums).slice(0, 12)}`);
    expect(version).toMatch(/^q4-0-[0-9a-f]{12}$/);
  });

  it('falls back to the bare 12-char hash when no quant token is known', () => {
    const sums = buildSha256SumsContent([{ path: 'a.bin', sha256: 'aaa' }]);
    const version = deriveModelVersion(null, sums);
    expect(version).toBe(sha256Hex(sums).slice(0, 12));
    expect(version).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is content-derived: a different SHA256SUMS content yields a different version', () => {
    const sumsA = buildSha256SumsContent([{ path: 'a.gguf', sha256: 'aaa' }]);
    const sumsB = buildSha256SumsContent([{ path: 'a.gguf', sha256: 'bbb' }]);
    expect(deriveModelVersion('q4-0', sumsA)).not.toBe(deriveModelVersion('q4-0', sumsB));
  });
});
