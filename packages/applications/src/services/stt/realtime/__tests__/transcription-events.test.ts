/**
 * Transcription Events DTO Unit Tests
 *
 * Tests the event type enum, interfaces, and discriminated union
 * for correctness in serialization/deserialization and type narrowing.
 */

import { describe, it, expect } from 'vitest';
import {
  TranscriptionEventType,
  TranscriptionEvent,
  TranscriptionStatusEvent,
  TranscriptionProgressEvent,
  TranscriptionChunkEvent,
  TranscriptionTranscriptEvent,
  TranscriptionErrorEvent,
  WordTimestamp,
  SentenceTimestamp,
} from '../dto';

describe('TranscriptionEventType', () => {
  it('should have correct enum values', () => {
    expect(TranscriptionEventType.STATUS).toBe('status');
    expect(TranscriptionEventType.PROGRESS).toBe('progress');
    expect(TranscriptionEventType.CHUNK).toBe('chunk');
    expect(TranscriptionEventType.TRANSCRIPT).toBe('transcript');
    expect(TranscriptionEventType.ERROR).toBe('error');
  });

  it('should have exactly 5 event types', () => {
    const values = Object.values(TranscriptionEventType);
    expect(values).toHaveLength(5);
  });
});

describe('TranscriptionEvent serialization', () => {
  it('should serialize and deserialize status event', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.STATUS,
      data: {
        jobId: 'job-001',
        status: 'PROCESSING',
        timestamp: '2026-02-10T12:00:00Z',
        workerId: 'worker-1',
      },
    };

    const json = JSON.stringify(event);
    const parsed: TranscriptionEvent = JSON.parse(json);

    expect(parsed.type).toBe('status');
    expect(parsed.data).toEqual(event.data);
  });

  it('should serialize status event without optional workerId', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.STATUS,
      data: {
        jobId: 'job-001',
        status: 'QUEUED',
        timestamp: '2026-02-10T12:00:00Z',
      },
    };

    const json = JSON.stringify(event);
    const parsed = JSON.parse(json);

    expect(parsed.data.workerId).toBeUndefined();
  });

  it('should serialize and deserialize progress event', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.PROGRESS,
      data: {
        jobId: 'job-001',
        progress: 45,
        stage: 'inference',
      },
    };

    const json = JSON.stringify(event);
    const parsed: TranscriptionEvent = JSON.parse(json);

    expect(parsed.type).toBe('progress');
    expect(parsed.data).toEqual(event.data);
  });

  it('should serialize progress event without optional stage', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.PROGRESS,
      data: {
        jobId: 'job-001',
        progress: 75,
      },
    };

    const json = JSON.stringify(event);
    const parsed = JSON.parse(json);

    expect(parsed.data.stage).toBeUndefined();
    expect(parsed.data.progress).toBe(75);
  });

  it('should serialize and deserialize chunk event', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.CHUNK,
      data: {
        jobId: 'job-001',
        chunkIndex: 3,
        text: 'The patient reports mild discomfort.',
        startTime: 12.5,
        endTime: 17.3,
        isFinal: false,
        wordTimestamps: [
          { word: 'The', start: 12.5, end: 12.7, confidence: 0.99 },
          { word: 'patient', start: 12.8, end: 13.2, confidence: 0.97 },
        ],
      },
    };

    const json = JSON.stringify(event);
    const parsed: TranscriptionEvent = JSON.parse(json);

    expect(parsed.type).toBe('chunk');
    expect(parsed.data).toEqual(event.data);
  });

  it('should serialize chunk event without optional wordTimestamps', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.CHUNK,
      data: {
        jobId: 'job-001',
        chunkIndex: 0,
        text: 'Hello world',
        startTime: 0,
        endTime: 1.5,
        isFinal: true,
      },
    };

    const json = JSON.stringify(event);
    const parsed = JSON.parse(json);

    expect(parsed.data.wordTimestamps).toBeUndefined();
    expect(parsed.data.isFinal).toBe(true);
  });

  it('should serialize and deserialize transcript event', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.TRANSCRIPT,
      data: {
        jobId: 'job-001',
        text: 'Full transcript text here.',
        language: 'en',
        languageProbability: 0.95,
        durationSeconds: 120.5,
        processingTimeSeconds: 8.3,
        wordTimestamps: [{ word: 'Full', startTime: 0, endTime: 0.3, confidence: 0.99 }],
        sentenceTimestamps: [{ text: 'Full transcript text here.', startTime: 0, endTime: 2.5 }],
        metadata: {
          timing: { totalMs: 8300 },
          model: 'whisper-large-v3-turbo',
        },
      },
    };

    const json = JSON.stringify(event);
    const parsed: TranscriptionEvent = JSON.parse(json);

    expect(parsed.type).toBe('transcript');
    expect(parsed.data).toEqual(event.data);
  });

  it('should serialize transcript event without optional fields', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.TRANSCRIPT,
      data: {
        jobId: 'job-001',
        text: 'Hello world',
        durationSeconds: 1.5,
        processingTimeSeconds: 0.5,
        wordTimestamps: [],
        sentenceTimestamps: [],
        metadata: {},
      },
    };

    const json = JSON.stringify(event);
    const parsed = JSON.parse(json);

    expect(parsed.data.language).toBeUndefined();
    expect(parsed.data.languageProbability).toBeUndefined();
  });

  it('should serialize and deserialize error event', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.ERROR,
      data: {
        jobId: 'job-001',
        errorCode: 'TRANSCRIPTION_ERROR',
        message: 'ASR model inference failed',
      },
    };

    const json = JSON.stringify(event);
    const parsed: TranscriptionEvent = JSON.parse(json);

    expect(parsed.type).toBe('error');
    expect(parsed.data).toEqual(event.data);
  });
});

describe('TranscriptionEvent type narrowing', () => {
  it('should narrow correctly with switch on type', () => {
    const events: TranscriptionEvent[] = [
      {
        type: TranscriptionEventType.STATUS,
        data: { jobId: 'j1', status: 'QUEUED', timestamp: '2026-01-01T00:00:00Z' },
      },
      {
        type: TranscriptionEventType.PROGRESS,
        data: { jobId: 'j1', progress: 50 },
      },
      {
        type: TranscriptionEventType.CHUNK,
        data: { jobId: 'j1', chunkIndex: 0, text: 'Hi', startTime: 0, endTime: 1, isFinal: false },
      },
      {
        type: TranscriptionEventType.TRANSCRIPT,
        data: {
          jobId: 'j1',
          text: 'Hi',
          durationSeconds: 1,
          processingTimeSeconds: 0.1,
          wordTimestamps: [],
          sentenceTimestamps: [],
          metadata: {},
        },
      },
      {
        type: TranscriptionEventType.ERROR,
        data: { jobId: 'j1', errorCode: 'ERR', message: 'fail' },
      },
    ];

    const types: string[] = [];
    for (const event of events) {
      switch (event.type) {
        case TranscriptionEventType.STATUS:
          types.push(`status:${event.data.status}`);
          break;
        case TranscriptionEventType.PROGRESS:
          types.push(`progress:${event.data.progress}`);
          break;
        case TranscriptionEventType.CHUNK:
          types.push(`chunk:${event.data.chunkIndex}`);
          break;
        case TranscriptionEventType.TRANSCRIPT:
          types.push(`transcript:${event.data.text.length}chars`);
          break;
        case TranscriptionEventType.ERROR:
          types.push(`error:${event.data.errorCode}`);
          break;
      }
    }

    expect(types).toEqual(['status:QUEUED', 'progress:50', 'chunk:0', 'transcript:2chars', 'error:ERR']);
  });
});

describe('Event data boundary values', () => {
  it('should handle progress at 0%', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.PROGRESS,
      data: { jobId: 'j1', progress: 0 },
    };

    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed.data.progress).toBe(0);
  });

  it('should handle progress at 100%', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.PROGRESS,
      data: { jobId: 'j1', progress: 100 },
    };

    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed.data.progress).toBe(100);
  });

  it('should handle empty transcript text', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.TRANSCRIPT,
      data: {
        jobId: 'j1',
        text: '',
        durationSeconds: 0,
        processingTimeSeconds: 0,
        wordTimestamps: [],
        sentenceTimestamps: [],
        metadata: {},
      },
    };

    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed.data.text).toBe('');
  });

  it('should handle chunk at startTime 0', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.CHUNK,
      data: {
        jobId: 'j1',
        chunkIndex: 0,
        text: 'Hello',
        startTime: 0,
        endTime: 0.5,
        isFinal: false,
      },
    };

    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed.data.startTime).toBe(0);
  });

  it('should handle all valid status values', () => {
    const statuses: Array<'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED'> = ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'];

    for (const status of statuses) {
      const event: TranscriptionEvent = {
        type: TranscriptionEventType.STATUS,
        data: { jobId: 'j1', status, timestamp: '2026-01-01T00:00:00Z' },
      };

      const parsed = JSON.parse(JSON.stringify(event));
      expect(parsed.data.status).toBe(status);
    }
  });

  it('should handle negative progress values (edge case)', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.PROGRESS,
      data: { jobId: 'j1', progress: -1 },
    };

    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed.data.progress).toBe(-1);
  });

  it('should handle fractional progress values', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.PROGRESS,
      data: { jobId: 'j1', progress: 33.33 },
    };

    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed.data.progress).toBeCloseTo(33.33);
  });

  it('should handle chunk with large chunkIndex', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.CHUNK,
      data: {
        jobId: 'j1',
        chunkIndex: 9999,
        text: 'Last chunk',
        startTime: 3600.0,
        endTime: 3602.5,
        isFinal: true,
      },
    };

    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed.data.chunkIndex).toBe(9999);
    expect(parsed.data.isFinal).toBe(true);
  });

  it('should handle transcript with many word timestamps', () => {
    const words: WordTimestamp[] = Array.from({ length: 500 }, (_, i) => ({
      word: `word${i}`,
      start: i * 0.3,
      end: i * 0.3 + 0.25,
      confidence: Math.random(),
    }));

    const event: TranscriptionEvent = {
      type: TranscriptionEventType.TRANSCRIPT,
      data: {
        jobId: 'j1',
        text: words.map((w) => w.word).join(' '),
        durationSeconds: 150.0,
        processingTimeSeconds: 12.5,
        wordTimestamps: words,
        sentenceTimestamps: [],
        metadata: {},
      },
    };

    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed.data.wordTimestamps).toHaveLength(500);
    expect(parsed.data.wordTimestamps[0].word).toBe('word0');
    expect(parsed.data.wordTimestamps[499].word).toBe('word499');
  });

  it('should handle error event with long message text', () => {
    const longMessage = 'Error detail: ' + 'x'.repeat(10_000);
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.ERROR,
      data: {
        jobId: 'j1',
        errorCode: 'INTERNAL_ERROR',
        message: longMessage,
      },
    };

    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed.data.message).toBe(longMessage);
    expect(parsed.data.message.length).toBe(14 + 10_000);
  });

  it('should handle special characters in text fields', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.CHUNK,
      data: {
        jobId: 'j1',
        chunkIndex: 0,
        text: 'He said "hello" & she said \'goodbye\' <br/> \n\t',
        startTime: 0,
        endTime: 2.0,
        isFinal: false,
      },
    };

    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed.data.text).toContain('"hello"');
    expect(parsed.data.text).toContain('&');
    expect(parsed.data.text).toContain('<br/>');
  });

  it('should handle unicode/emoji in transcript text', () => {
    const event: TranscriptionEvent = {
      type: TranscriptionEventType.TRANSCRIPT,
      data: {
        jobId: 'j1',
        text: 'Le patient dit « bonjour » 你好世界',
        language: 'multi',
        durationSeconds: 5.0,
        processingTimeSeconds: 1.0,
        wordTimestamps: [],
        sentenceTimestamps: [],
        metadata: {},
      },
    };

    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed.data.text).toContain('bonjour');
    expect(parsed.data.text).toContain('你好世界');
  });
});

describe('WordTimestamp and SentenceTimestamp', () => {
  it('should export WordTimestamp type that matches expected shape', () => {
    const word: WordTimestamp = {
      word: 'hello',
      start: 0.0,
      end: 0.5,
      confidence: 0.99,
    };

    expect(word.word).toBe('hello');
    expect(word.start).toBe(0.0);
    expect(word.end).toBe(0.5);
    expect(word.confidence).toBe(0.99);
  });

  it('should export SentenceTimestamp type that matches expected shape', () => {
    const sentence: SentenceTimestamp = {
      text: 'Hello world.',
      startTime: 0.0,
      endTime: 1.5,
    };

    expect(sentence.text).toBe('Hello world.');
    expect(sentence.startTime).toBe(0.0);
    expect(sentence.endTime).toBe(1.5);
  });

  it('should handle WordTimestamp with zero confidence', () => {
    const word: WordTimestamp = {
      word: 'um',
      start: 5.0,
      end: 5.2,
      confidence: 0.0,
    };

    const parsed = JSON.parse(JSON.stringify(word));
    expect(parsed.confidence).toBe(0.0);
  });

  it('should handle SentenceTimestamp round-trip serialization', () => {
    const sentences: SentenceTimestamp[] = [
      { text: 'First sentence.', startTime: 0, endTime: 2.5 },
      { text: 'Second sentence.', startTime: 2.6, endTime: 5.0 },
    ];

    const parsed = JSON.parse(JSON.stringify(sentences));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].text).toBe('First sentence.');
    expect(parsed[1].startTime).toBe(2.6);
  });
});

describe('Real-world Python publisher payloads', () => {
  it('should deserialize a realistic status event from STT-v2 Python service', () => {
    // Matches the format published by TranscriptionEventPublisher in Python
    const rawJson =
      '{"type":"status","data":{"jobId":"019497a2-7c8e-7000-8000-abcdef123456","status":"PROCESSING","timestamp":"2026-02-10T14:30:00.000Z","workerId":"stt-worker-01"}}';

    const event: TranscriptionEvent = JSON.parse(rawJson);
    expect(event.type).toBe(TranscriptionEventType.STATUS);
    expect(event.data.jobId).toBe('019497a2-7c8e-7000-8000-abcdef123456');
    if (event.type === TranscriptionEventType.STATUS) {
      expect(event.data.status).toBe('PROCESSING');
      expect(event.data.workerId).toBe('stt-worker-01');
    }
  });

  it('should deserialize a realistic chunk event from STT-v2 Python service', () => {
    const rawJson = JSON.stringify({
      type: 'chunk',
      data: {
        jobId: '019497a2-7c8e-7000-8000-abcdef123456',
        chunkIndex: 3,
        text: 'The patient reports experiencing moderate chest pain for the past two days.',
        startTime: 45.2,
        endTime: 52.8,
        isFinal: false,
        wordTimestamps: [
          { word: 'The', start: 45.2, end: 45.4, confidence: 0.99 },
          { word: 'patient', start: 45.5, end: 45.9, confidence: 0.97 },
          { word: 'reports', start: 46.0, end: 46.4, confidence: 0.98 },
        ],
      },
    });

    const event: TranscriptionEvent = JSON.parse(rawJson);
    expect(event.type).toBe(TranscriptionEventType.CHUNK);
    if (event.type === TranscriptionEventType.CHUNK) {
      expect(event.data.chunkIndex).toBe(3);
      expect(event.data.text).toContain('chest pain');
      expect(event.data.wordTimestamps).toHaveLength(3);
      expect(event.data.wordTimestamps![0].confidence).toBeGreaterThan(0.9);
    }
  });

  it('should deserialize a realistic transcript event from STT-v2 Python service', () => {
    const rawJson = JSON.stringify({
      type: 'transcript',
      data: {
        jobId: '019497a2-7c8e-7000-8000-abcdef123456',
        text: 'Full consultation transcript spanning multiple sentences and medical terminology.',
        language: 'en',
        languageProbability: 0.98,
        durationSeconds: 1847.3,
        processingTimeSeconds: 42.7,
        wordTimestamps: [{ word: 'Full', start: 0.0, end: 0.3, confidence: 0.99 }],
        sentenceTimestamps: [
          { text: 'Full consultation transcript spanning multiple sentences and medical terminology.', startTime: 0.0, endTime: 5.2 },
        ],
        metadata: {
          timing: { totalMs: 42700, preprocessingMs: 1200, inferenceMs: 40000, postprocessingMs: 1500 },
          model: 'whisper-large-v3-turbo',
          pipeline: 'batch-v2',
          audioFormat: 'wav',
          sampleRate: 16000,
        },
      },
    });

    const event: TranscriptionEvent = JSON.parse(rawJson);
    expect(event.type).toBe(TranscriptionEventType.TRANSCRIPT);
    if (event.type === TranscriptionEventType.TRANSCRIPT) {
      expect(event.data.language).toBe('en');
      expect(event.data.languageProbability).toBe(0.98);
      expect(event.data.durationSeconds).toBeGreaterThan(1800);
      expect(event.data.metadata).toHaveProperty('timing');
      expect(event.data.metadata).toHaveProperty('model');
      expect(event.data.sentenceTimestamps).toHaveLength(1);
    }
  });

  it('should deserialize a realistic error event from STT-v2 Python service', () => {
    const rawJson =
      '{"type":"error","data":{"jobId":"019497a2-7c8e-7000-8000-abcdef123456","errorCode":"MODEL_LOAD_FAILED","message":"Failed to load whisper model: CUDA out of memory. Tried to allocate 2.00 GiB"}}';

    const event: TranscriptionEvent = JSON.parse(rawJson);
    expect(event.type).toBe(TranscriptionEventType.ERROR);
    if (event.type === TranscriptionEventType.ERROR) {
      expect(event.data.errorCode).toBe('MODEL_LOAD_FAILED');
      expect(event.data.message).toContain('CUDA out of memory');
    }
  });
});
