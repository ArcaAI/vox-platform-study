/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

export enum ConsultationStatus {
  OPEN = 'OPEN',
  RECORDING = 'RECORDING',
  // Draft delivered early (readable); assurance running concurrently.
  DRAFT_PENDING_SENSORS = 'DRAFT_PENDING_SENSORS',
  PENDING_REVIEW = 'PENDING_REVIEW',
  SIGNED = 'SIGNED',
  CLOSED = 'CLOSED',
  REOPENED = 'REOPENED',
  PRIMED = 'PRIMED',
  DRAINING = 'DRAINING',
  TIMED_OUT = 'TIMED_OUT',
  CLOSED_COMPLETE = 'CLOSED_COMPLETE',
  CLOSED_INCOMPLETE = 'CLOSED_INCOMPLETE',
}
