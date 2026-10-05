/** A written note is IDLE + NOTE_READY; AWAITING_REVIEW is reserved for a note a human must look at. */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ConsultationResponse } from '../../../../../../packages/applications/src/services/consultation/consultation/dto/consultation.response';
import { CaptureStateResponse } from '../dto/lifecycle.response';

const described = (target: object, property: string): string =>
  (Reflect.getMetadata('swagger/apiModelProperties', target, property) as { description?: string }).description ?? '';

describe('processing wording', () => {
  it('the capture-state response says a written note is IDLE + NOTE_READY', () => {
    const text = described(CaptureStateResponse.prototype, 'processing');
    expect(text).toContain('NOTE_READY');
    expect(text).toContain('AWAITING_REVIEW');
  });

  it('the consultation response names NOTE_READY as a processing reason', () => {
    expect(described(ConsultationResponse.prototype, 'processingReason')).toContain('NOTE_READY');
  });
});
