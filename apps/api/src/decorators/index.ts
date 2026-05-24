// Swagger/OpenAPI decorators (stay in API layer)
export * from './apiEndpoint.decorator';
export * from './apiPaginated.response';
export * from './apiSingle.response';

// TASK-302 Stream D Phase D — Optimistic-locking decorators (HTTP layer)
export * from './expectedVersion.decorator';
export * from './requiresIfMatch.decorator';
export * from './requiresIfMatch.guard';

// Auth decorators — re-exported from @arcaai/applications
export {
  Authorize,
  AuthorizeAny,
  Public,
  CanRead,
  CanList,
  CanCreate,
  CanUpdate,
  CanDelete,
  CanManage,
  CanAny,
  CanAll,
  UserAbility,
  SetPermissions,
  SetPermissionMode,
} from '@arcaai/applications';
