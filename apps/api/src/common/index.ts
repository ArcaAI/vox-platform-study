/**
 * Barrel for `apps/api/src/common` — TASK-307 W3 cross-cutting primitives.
 */
export {
  TenantOwnedResource,
  TENANT_OWNED_RESOURCE_KEY,
  type TenantOwnedResourceOptions,
  type TenantOwnedResourceModelName,
} from './tenant-owned-resource.decorator';
export { TenantOwnedResourceInterceptor } from './tenant-owned-resource.interceptor';
export { TenantOwnedResourceModule } from './tenant-owned-resource.module';
