/**
 * AudioRecordingFactory + AudioRecordingEntityMapper — rawMediaId/processedMediaId.
 *
 * Dual capture: the Prisma columns
 * `AudioRecording.rawMediaId` (String?) and `AudioRecording.processedMediaId` (String?)
 * already exist; this slice threads them through the domain layer
 * (entity ⇄ model) so the application/API layers can persist both streams.
 */
import { describe, it, expect } from 'vitest';
import { AudioRecordingFactory } from '../AudioRecordingFactory';
import { AudioRecordingEntityMapper } from '../../../../mappers/generated/core/AudioRecordingEntityMapper';
import { AudioRecording } from '../../../../models/generated/core/AudioRecordingModel';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

describe('AudioRecordingFactory — rawMediaId/processedMediaId', () => {
  it('threads rawMediaId/processedMediaId onto the created entity', () => {
    const entity = AudioRecordingFactory.CreateAudioRecording({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      mediaId: 'media-primary',
      rawMediaId: 'media-raw',
      processedMediaId: 'media-processed',
    });

    expect(entity.mediaId).toBe('media-primary');
    expect(entity.rawMediaId).toBe('media-raw');
    expect(entity.processedMediaId).toBe('media-processed');
  });

  it('defaults rawMediaId/processedMediaId to null when omitted', () => {
    const entity = AudioRecordingFactory.CreateAudioRecording({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      mediaId: 'media-primary',
    });

    expect(entity.rawMediaId).toBeNull();
    expect(entity.processedMediaId).toBeNull();
  });

  it('CreateWithMetadata accepts rawMediaId/processedMediaId in the metadata bag', () => {
    const entity = AudioRecordingFactory.CreateWithMetadata(
      TENANT_ID,
      'ctx-1',
      'media-primary',
      { rawMediaId: 'media-raw', processedMediaId: 'media-processed', duration: 1000 },
      2,
    );

    expect(entity.rawMediaId).toBe('media-raw');
    expect(entity.processedMediaId).toBe('media-processed');
    expect(entity.sequenceNumber).toBe(2);
  });
});

describe('AudioRecordingEntityMapper — rawMediaId/processedMediaId round-trip', () => {
  const mapper = new AudioRecordingEntityMapper();

  it('toPersistence carries rawMediaId/processedMediaId to the data model', () => {
    const entity = AudioRecordingFactory.CreateAudioRecording({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      mediaId: 'media-primary',
      rawMediaId: 'media-raw',
      processedMediaId: 'media-processed',
    });

    const model = mapper.toPersistence(entity);

    expect(model.mediaId).toBe('media-primary');
    expect(model.rawMediaId).toBe('media-raw');
    expect(model.processedMediaId).toBe('media-processed');
  });

  it('toDomainEntity carries rawMediaId/processedMediaId from the database row', () => {
    const row = new AudioRecording({
      id: 'ar-1',
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      mediaId: 'media-primary',
      rawMediaId: 'media-raw',
      processedMediaId: 'media-processed',
      duration: null,
      format: null,
      sampleRate: null,
      channels: null,
      bitrate: null,
      language: null,
      sequenceNumber: 1,
      recordedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as AudioRecording);

    const entity = mapper.toDomainEntity(row);

    expect(entity.rawMediaId).toBe('media-raw');
    expect(entity.processedMediaId).toBe('media-processed');
  });
});
