import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  AttachmentPolicyError,
  CreateAttachmentIntentRequest,
  assertKindSupported,
  attachmentExtension,
  buildAttachmentObjectKey,
  deriveSupportedKinds,
  isMimeAllowedForKind,
  resolveMaxSizeBytes,
  validateIntent,
} from '../index';
import { MEDIA_AUDIO_MIME_TYPES, attachmentContentMatches, audioContentMatches, isStrictUtf8 } from '../../../media-upload/media-content-sniff';

const sizes = { maxAttachmentSizeMb: 25, maxAudioSizeMb: 250, batchMaxFileSizeMb: 100 };

describe('kind <-> mime table', () => {
  it('maps each kind to its allow-list', () => {
    expect(isMimeAllowedForKind('document', 'application/pdf')).toBe(true);
    expect(isMimeAllowedForKind('document', 'image/png')).toBe(false);
    expect(isMimeAllowedForKind('image', 'image/jpg')).toBe(true);
    expect(isMimeAllowedForKind('image', 'application/pdf')).toBe(false);
    expect(isMimeAllowedForKind('case_note', 'text/plain; charset=utf-8')).toBe(true);
    expect(isMimeAllowedForKind('case_note', 'text/markdown')).toBe(false);
    for (const mime of MEDIA_AUDIO_MIME_TYPES) expect(isMimeAllowedForKind('audio', mime)).toBe(true);
    expect(isMimeAllowedForKind('audio', 'audio/midi')).toBe(false);
  });
  it('derives an extension', () => {
    expect(attachmentExtension('application/pdf')).toBe('pdf');
    expect(attachmentExtension('IMAGE/JPG')).toBe('jpg');
    expect(attachmentExtension('audio/x-m4a')).toBe('m4a');
  });
});

describe('size ceilings', () => {
  it('uses the attachment ceiling for non-audio and the tighter of audio/batch for audio', () => {
    expect(resolveMaxSizeBytes('document', sizes)).toBe(25 * 1024 * 1024);
    expect(resolveMaxSizeBytes('case_note', sizes)).toBe(25 * 1024 * 1024);
    expect(resolveMaxSizeBytes('audio', sizes)).toBe(100 * 1024 * 1024);
    expect(resolveMaxSizeBytes('audio', { ...sizes, batchMaxFileSizeMb: 500 })).toBe(250 * 1024 * 1024);
  });
});

describe('object key', () => {
  const base = { consultationId: 'c-1', attachmentId: 'a-1', mime: 'application/pdf', now: new Date('2026-03-07T10:00:00Z') };
  it('is built from ids only', () => {
    expect(buildAttachmentObjectKey({ ...base, purpose: 'attachment' })).toBe('consultations/2026/03/c-1/attachments/a-1/a-1.pdf');
    expect(buildAttachmentObjectKey({ ...base, purpose: 'feedback' })).toBe('consultations/2026/03/c-1/feedback/a-1/a-1.pdf');
  });
  it('rejects an id that could escape the prefix', () => {
    expect(() => buildAttachmentObjectKey({ ...base, consultationId: '../x', purpose: 'attachment' })).toThrow();
  });
});

describe('deriveSupportedKinds', () => {
  it('always has case_note; audio follows ASR; default engine has document but not image', () => {
    expect(deriveSupportedKinds({ asrResolvable: false, governed: false, subscriptions: [] })).toEqual(['document', 'case_note']);
    expect(deriveSupportedKinds({ asrResolvable: true, governed: false, subscriptions: [] })).toEqual(['document', 'audio', 'case_note']);
  });
  it('a governed consultation needs the subscription for document; image needs vision', () => {
    expect(deriveSupportedKinds({ asrResolvable: false, governed: true, subscriptions: [] })).toEqual(['case_note']);
    expect(deriveSupportedKinds({ asrResolvable: false, governed: true, subscriptions: ['document.extract_text'] })).toEqual(['document', 'case_note']);
    expect(deriveSupportedKinds({ asrResolvable: false, governed: false, subscriptions: ['vision.extract_text'] })).toEqual(['document', 'image', 'case_note']);
  });
});

describe('validateIntent', () => {
  const supported = ['document', 'case_note'] as const;
  const run = (over: Partial<Parameters<typeof validateIntent>[0]>) =>
    validateIntent({ kind: 'document', mime: 'application/pdf', sizeBytes: 100, supportedKinds: supported, sizes, ...over });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e as AttachmentPolicyError;
    }
    throw new Error('did not throw');
  };
  it('accepts and normalises', () => {
    expect(run({ mime: 'Application/PDF' })).toEqual({ mime: 'application/pdf', maxSizeBytes: 25 * 1024 * 1024 });
  });
  it('422 for an unsupported kind, carrying the supported ones', () => {
    const e = code(() => run({ kind: 'image', mime: 'image/png' }));
    expect([e.code, e.httpStatus, e.details.supportedKinds]).toEqual(['ATTACHMENT_KIND_UNSUPPORTED', 422, ['document', 'case_note']]);
    expect(() => assertKindSupported('document', supported)).not.toThrow();
  });
  it('415 for a mime outside the kind, 413 for too large', () => {
    expect(code(() => run({ mime: 'image/png' })).httpStatus).toBe(415);
    const e = code(() => run({ sizeBytes: 26 * 1024 * 1024 }));
    expect([e.code, e.httpStatus]).toEqual(['ATTACHMENT_TOO_LARGE', 413]);
  });
});

describe('content sniff (extracted)', () => {
  it('matches signatures and strict UTF-8', () => {
    expect(attachmentContentMatches('application/pdf', Buffer.from('%PDF-1.7'))).toBe(true);
    expect(attachmentContentMatches('application/pdf', Buffer.from('hello'))).toBe(false);
    expect(attachmentContentMatches('text/plain', Buffer.from([0x61, 0x00]))).toBe(false);
    expect(audioContentMatches('audio/flac', Buffer.from('fLaC....'))).toBe(true);
    expect(audioContentMatches('audio/flac', Buffer.from('nope'))).toBe(false);
    expect(isStrictUtf8(Buffer.from('héllo നമസ്കാരം'))).toBe(true);
    expect(isStrictUtf8(Buffer.from([0xc3, 0x28]))).toBe(false);
  });
});

describe('CreateAttachmentIntentRequest', () => {
  const sha256 = 'a'.repeat(64);
  const check = (plain: object) =>
    validate(plainToInstance(CreateAttachmentIntentRequest, plain), { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
  it('accepts a valid body', async () => {
    expect(await check({ kind: 'document', mime: 'application/pdf', sizeBytes: 10, sha256, purpose: 'feedback', encounterSeq: 1 })).toEqual([]);
  });
  it('rejects bad kind, size, sha and unknown fields', async () => {
    const errors = await check({ kind: 'video', mime: 'x', sizeBytes: 0, sha256: 'XYZ', extra: 1 });
    expect(errors.map((e) => e.property).sort()).toEqual(['extra', 'kind', 'sha256', 'sizeBytes']);
  });
});
