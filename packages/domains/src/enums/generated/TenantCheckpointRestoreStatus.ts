/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

export enum TenantCheckpointRestoreStatus {
  PENDING = 'PENDING',
  LOCKING = 'LOCKING',
  SAFETY_CHECKPOINT = 'SAFETY_CHECKPOINT',
  VERIFYING = 'VERIFYING',
  RECONCILING = 'RECONCILING',
  POST_COMMIT = 'POST_COMMIT',
  COMPLETED = 'COMPLETED',
  COMPLETED_WITH_WARNINGS = 'COMPLETED_WITH_WARNINGS',
  FAILED = 'FAILED',
}
