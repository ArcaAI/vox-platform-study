/**
 * Pure content-addressed version derivation for the `hope-models` bucket
 * layout — see `infrastructure/docker/minio/README.md`
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
  isModelWeightFile,
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

/**
 * the fetch allowlist must actually reach the weights of the three
 * models nominated for end-to-end validation. Before this suite, two of the
 * three published NO weight file at all, silently: the selection simply
 * returned companions (or nothing) and the publish "succeeded".
 *
 * File lists below are the REAL repo contents, read from the HuggingFace API
 * on 2026-09-02, not invented fixtures.
 */
describe('isRelevantModelSourceFile — real repo listings ', () => {
  const MEDICAL_NER = [
    '.gitattributes',
    'README.md',
    'added_tokens.json',
    'config.json',
    'model.safetensors',
    'special_tokens_map.json',
    'spm.model',
    'tokenizer.json',
    'tokenizer_config.json',
    'training_args.bin',
  ];
  const QWEN3_GGUF = ['Qwen3-0.6B-Q4_K_S.gguf'];
  const WHISPER_GGML = [
    '.gitattributes',
    'README.md',
    'ggml-whisper-large-en-medical-2607.26-f16.bin',
    'ggml-whisper-large-en-medical-2607.26-q5_0.bin',
    'ggml-whisper-large-en-medical-2607.26-q8_0.bin',
  ];

  const kept = (files: string[]) => files.filter(isRelevantModelSourceFile);

  it('blaze999/Medical-NER: keeps the safetensors weights and the sentencepiece model', () => {
    const files = kept(MEDICAL_NER);
    expect(files).toContain('model.safetensors');
    expect(files).toContain('spm.model');
    expect(files).toContain('added_tokens.json');
  });

  it('blaze999/Medical-NER: drops trainer bookkeeping that shares the .bin extension', () => {
    expect(kept(MEDICAL_NER)).not.toContain('training_args.bin');
  });

  it('unsloth/Qwen3-0.6B-GGUF: keeps the GGUF (unchanged behaviour)', () => {
    expect(kept(QWEN3_GGUF)).toEqual(['Qwen3-0.6B-Q4_K_S.gguf']);
  });

  it('whisper ggml: keeps .bin weights even though the repo name says gguf', () => {
    const files = kept(WHISPER_GGML);
    expect(files).toContain('ggml-whisper-large-en-medical-2607.26-q5_0.bin');
    expect(files).not.toContain('README.md');
  });

  it('every nominated repo yields at least one weight file', () => {
    for (const files of [MEDICAL_NER, QWEN3_GGUF, WHISPER_GGML]) {
      const weights = kept(files).filter((f) => /\.(gguf|safetensors|bin|onnx|nemo|pt|pth)$/i.test(f));
      expect(weights.length).toBeGreaterThan(0);
    }
  });
});

/**
 * TASK-960 — `isModelWeightFile` is the narrower half of
 * `isRelevantModelSourceFile`: WEIGHTS ONLY, no tokenizer/config companions.
 *
 * The model inventory uses it to decide whether a manifest-less bucket prefix
 * is an admin-staged MODEL or just a directory of loose files, so a prefix
 * holding only a `config.json` must NOT qualify.
 */
describe('isModelWeightFile', () => {
  it('accepts every weight extension the platform can serve', () => {
    for (const path of ['model.gguf', 'model.safetensors', 'ggml-whisper-f16.bin', 'silero_vad.onnx', 'parakeet.nemo', 'kokoro.pt', 'voices.pth', 'spm.model']) {
      expect(isModelWeightFile(path)).toBe(true);
    }
  });

  it('rejects the tokenizer/config companions that `isRelevantModelSourceFile` keeps', () => {
    for (const path of ['config.json', 'tokenizer.json', 'merges.txt', 'preprocessor_config.json']) {
      expect(isModelWeightFile(path)).toBe(false);
      expect(isRelevantModelSourceFile(path)).toBe(true);
    }
  });

  it('rejects trainer bookkeeping that shares the .bin/.pt extensions', () => {
    expect(isModelWeightFile('training_args.bin')).toBe(false);
    expect(isModelWeightFile('optimizer.pt')).toBe(false);
  });

  it('rejects unrelated files and matches on the basename of a nested path', () => {
    expect(isModelWeightFile('README.md')).toBe(false);
    expect(isModelWeightFile('a/b/c/model.safetensors')).toBe(true);
  });
});
