// Policy Engine
export { PolicyEngine } from './policy.engine';
export type { AppAbility, PolicyRule, PolicyContext } from './policy.engine';

// Authorization Guard (legacy — prefer UnifiedAuthGuard)
export { AuthorizationGuard, REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY, PERMISSION_MODE_KEY } from './authorization.guard';
export type { RequiredPermission, PermissionMode } from './authorization.guard';

// Unified Auth Guard
export { UnifiedAuthGuard, JWT_AUTH_GUARD, API_KEY_REQUIRED_SCOPES } from './unified-auth.guard';

// Decorators
export {
  Public,
  SetPermissions,
  SetPermissionMode,
  Authorize,
  AuthorizeAny,
  UserAbility,
  CanRead,
  CanList,
  CanCreate,
  CanUpdate,
  CanDelete,
  CanManage,
  CanAny,
  CanAll,
} from './decorators';

// Module
export { AuthorizationModule } from './authorization.module';
