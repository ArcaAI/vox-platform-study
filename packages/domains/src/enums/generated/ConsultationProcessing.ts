/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

export enum ConsultationProcessing {
  IDLE = 'IDLE',
  FINALIZING_TRANSCRIPT = 'FINALIZING_TRANSCRIPT',
  SUMMARIZING = 'SUMMARIZING',
  PROCESSING_ATTACHMENT = 'PROCESSING_ATTACHMENT',
  AWAITING_REVIEW = 'AWAITING_REVIEW',
  FAILED = 'FAILED',
}
