import type { UseUsersReturn } from '@arcaai/vox';

/**
 * The `@arcaai/vox` barrel exports `useUsers` + `UseUsersReturn` but NOT the bare
 * input/result shapes for the TASK-388 reset-password / bulk / export actions. We
 * derive them from the hook's method signatures so the SDK package stays untouched
 * (same approach as `features/tenants/sdk-types.ts`).
 */

type ResetPasswordFn = UseUsersReturn['resetPassword'];
/** `{ mode, temporaryPassword?, token?, resetPath?, expiresInSeconds?, emailSent? }`. */
export type ResetPasswordResult = Awaited<ReturnType<ResetPasswordFn>>;
/** `'temporary' | 'link'`. */
export type ResetPasswordMode = NonNullable<NonNullable<Parameters<ResetPasswordFn>[1]>['mode']>;

type BulkActionFn = UseUsersReturn['bulkAction'];
export type BulkUserActionInput = Parameters<BulkActionFn>[0];
export type BulkUserActionType = BulkUserActionInput['action'];
export type BulkUserActionResult = Awaited<ReturnType<BulkActionFn>>;

type ExportFn = UseUsersReturn['exportUsers'];
export type UserExportQuery = Parameters<ExportFn>[0];
export type UserExportFormat = UserExportQuery['format'];
