import { SetMetadata, applyDecorators, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY, PERMISSION_MODE_KEY, RequiredPermission, PermissionMode } from './authorization.guard';

/**
 * Mark route as public (no authentication or authorization required)
 *
 * @example
 * ```typescript
 * @Get('health')
 * @Public()
 * healthCheck() { ... }
 * ```
 */
export const Public = () => SetMetadata(SKIP_AUTH_KEY, true);

/**
 * Set required permissions for a route
 * This is a low-level decorator - prefer using Authorize() instead
 *
 * @param permissions - Array of [action, subject] tuples
 */
export const SetPermissions = (...permissions: [string, string][]) => {
  const required: RequiredPermission[] = permissions.map(([action, subject]) => ({
    action,
    subject,
  }));
  return SetMetadata(REQUIRED_PERMISSIONS_KEY, required);
};

/**
 * Set permission mode for a route
 * @param mode - 'AND' (all required) or 'OR' (any one required)
 */
export const SetPermissionMode = (mode: PermissionMode) => SetMetadata(PERMISSION_MODE_KEY, mode);

/**
 * Require specific permissions for a route (AND logic - all required)
 *
 * Metadata-only (TASK-343): sets `REQUIRED_PERMISSIONS_KEY` + `PERMISSION_MODE_KEY`
 * and tags Swagger with `@ApiBearerAuth()`. Enforcement is handled by the global
 * `UnifiedAuthGuard` (`APP_GUARD`) reading this metadata — this decorator no
 * longer re-applies `@UseGuards(UnifiedAuthGuard)`, which previously caused the
 * guard (and its CASL + Redis work) to run twice per request.
 *
 * @param permissions - Array of [action, subject] tuples
 *
 * @example
 * ```typescript
 * // Single permission
 * @Authorize(['read', 'User'])
 *
 * // Multiple permissions (AND logic - all required)
 * @Authorize(['read', 'User'], ['read', 'Tenant'])
 * ```
 */
export function Authorize(...permissions: [string, string][]) {
  const required: RequiredPermission[] = permissions.map(([action, subject]) => ({
    action,
    subject,
  }));

  return applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS_KEY, required),
    SetMetadata(PERMISSION_MODE_KEY, 'AND' as PermissionMode),
    ApiBearerAuth(),
  );
}

/**
 * Require ANY of the specified permissions (OR logic)
 * At least one permission must be satisfied
 *
 * Metadata-only (TASK-343): like {@link Authorize}, enforcement is delegated to
 * the global `UnifiedAuthGuard` (`APP_GUARD`); no route-level guard is attached.
 *
 * @param permissions - Array of [action, subject] tuples
 *
 * @example
 * ```typescript
 * @Get(':id/sensitive')
 * @AuthorizeAny(['manage', 'User'], ['read', 'AuditLog'])
 * getSensitiveData() { ... }
 * ```
 */
export function AuthorizeAny(...permissions: [string, string][]) {
  const required: RequiredPermission[] = permissions.map(([action, subject]) => ({
    action,
    subject,
  }));

  return applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS_KEY, required),
    SetMetadata(PERMISSION_MODE_KEY, 'OR' as PermissionMode),
    ApiBearerAuth(),
  );
}

/**
 * Parameter decorator to inject the user's CASL ability into controller method
 *
 * @example
 * ```typescript
 * @Get()
 * @Authorize(['read', 'User'])
 * findAll(@UserAbility() ability: AppAbility) {
 *   // Use ability for fine-grained checks
 *   if (ability.can('read', 'SensitiveData')) {
 *     // Include sensitive data
 *   }
 * }
 * ```
 */
export const UserAbility = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.ability;
});

/**
 * Require permission to read a resource
 *
 * @param subject - Resource type (e.g., 'User', 'Tenant')
 *
 * @example
 * ```typescript
 * @Get()
 * @CanRead('User')
 * findAll() { ... }
 * ```
 */
export const CanRead = (subject: string) => Authorize(['read', subject]);

/**
 * Require permission to list resources
 *
 * @param subject - Resource type
 */
export const CanList = (subject: string) => Authorize(['list', subject]);

/**
 * Require permission to create a resource
 *
 * @param subject - Resource type
 *
 * @example
 * ```typescript
 * @Post()
 * @CanCreate('User')
 * create(@Body() dto: CreateUserDto) { ... }
 * ```
 */
export const CanCreate = (subject: string) => Authorize(['create', subject]);

/**
 * Require permission to update a resource
 *
 * @param subject - Resource type
 *
 * @example
 * ```typescript
 * @Put(':id')
 * @CanUpdate('User')
 * update(@Param('id') id: string, @Body() dto: UpdateUserDto) { ... }
 * ```
 */
export const CanUpdate = (subject: string) => Authorize(['update', subject]);

/**
 * Require permission to delete a resource
 *
 * @param subject - Resource type
 *
 * @example
 * ```typescript
 * @Delete(':id')
 * @CanDelete('User')
 * remove(@Param('id') id: string) { ... }
 * ```
 */
export const CanDelete = (subject: string) => Authorize(['delete', subject]);

/**
 * Require full management permission for a resource
 * 'manage' is a special CASL action that grants all permissions
 *
 * @param subject - Resource type
 *
 * @example
 * ```typescript
 * @Controller('admin/users')
 * @CanManage('User')
 * export class AdminUsersController { ... }
 * ```
 */
export const CanManage = (subject: string) => Authorize(['manage', subject]);

/**
 * Require any of the specified permissions (OR logic)
 * At least one permission must be satisfied
 *
 * @param permissions - Array of [action, subject] tuples
 *
 * @example
 * ```typescript
 * @Get(':id/sensitive')
 * @CanAny(['manage', 'User'], ['read', 'AuditLog'])
 * getSensitiveData() { ... }
 * ```
 */
export const CanAny = (...permissions: [string, string][]) => AuthorizeAny(...permissions);

/**
 * Require all of the specified permissions (AND logic)
 * All permissions must be satisfied
 *
 * @param permissions - Array of [action, subject] tuples
 *
 * @example
 * ```typescript
 * @Post('transfer')
 * @CanAll(['update', 'Account'], ['create', 'Transaction'])
 * transfer() { ... }
 * ```
 */
export const CanAll = (...permissions: [string, string][]) => Authorize(...permissions);
