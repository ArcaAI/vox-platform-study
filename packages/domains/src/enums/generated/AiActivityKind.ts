/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

export enum AiActivityKind {
  TRANSCRIBE_STREAM = 'TRANSCRIBE_STREAM',
  TRANSCRIBE_BATCH = 'TRANSCRIBE_BATCH',
  NER = 'NER',
  LIVE_SUMMARY = 'LIVE_SUMMARY',
  PRE_SUMMARY = 'PRE_SUMMARY',
  FACT_LEDGER = 'FACT_LEDGER',
  NOTE_GENERATE = 'NOTE_GENERATE',
  NOTE_SECTION_GROUP = 'NOTE_SECTION_GROUP',
  NOTE_SECTION_REGEN = 'NOTE_SECTION_REGEN',
  NOTE_REPAIR = 'NOTE_REPAIR',
  SENSOR = 'SENSOR',
  ATTACHMENT_EXTRACT = 'ATTACHMENT_EXTRACT',
}
