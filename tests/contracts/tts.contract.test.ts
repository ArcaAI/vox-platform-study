/**
 * TTS Service Contract Tests
 *
 * Validates the request/response contract between the API Gateway and the TTS
 * (text-to-speech) Python service. Restores the contract coverage removed when
 * the legacy TTS service was deleted.
 */

import { describe, expect, it } from 'vitest';

import { TtsSynthesizeRequestSchema, TtsVoicesResponseSchema } from './schemas';

describe('TTS Service Contract', () => {
  it('accepts a valid synthesize request and applies defaults', () => {
    const parsed = TtsSynthesizeRequestSchema.parse({
      input: 'Continue Aspirin 75 mg once daily.',
      voice: 'en-female-1',
      response_format: 'pcm',
    });
    expect(parsed.speed).toBe(1.0);
  });

  it('accepts the code-switched Malayalam clinical shape', () => {
    const parsed = TtsSynthesizeRequestSchema.parse({
      input: 'രോഗിക്ക് Type 2 Diabetes Mellitus സ്ഥിരീകരിച്ചു.',
      voice: 'ml-female-1',
      stream_format: 'audio',
    });
    expect(parsed.voice).toBe('ml-female-1');
    expect(parsed.stream_format).toBe('audio');
  });

  it('rejects an empty input', () => {
    expect(() => TtsSynthesizeRequestSchema.parse({ input: '', voice: 'en-female-1' })).toThrow();
  });

  it('rejects out-of-range speed', () => {
    expect(() => TtsSynthesizeRequestSchema.parse({ input: 'x', voice: 'v', speed: 9 })).toThrow();
  });

  it('rejects an unknown response_format', () => {
    expect(() => TtsSynthesizeRequestSchema.parse({ input: 'x', voice: 'v', response_format: 'ogg' })).toThrow();
  });

  it('validates a voices response', () => {
    const parsed = TtsVoicesResponseSchema.parse({
      voices: [
        { id: 'en-female-1', locale: 'en-IN', providers: ['azure', 'kokoro'] },
        { id: 'ml-female-1', locale: 'ml-IN', providers: ['azure', 'indic_parler'] },
      ],
    });
    expect(parsed.voices).toHaveLength(2);
    expect(parsed.voices[1].locale).toBe('ml-IN');
  });
});
