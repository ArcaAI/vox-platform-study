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
export { TenantOwnedResourceSseGuard } from './tenant-owned-resource-sse.guard';
export { TenantOwnedResourceModule } from './tenant-owned-resource.module';
export {
  StreamSessionTenantBindingService,
  STREAM_SESSION_TENANT_KEY_PREFIX,
  STREAM_SESSION_TENANT_DEFAULT_TTL_SECONDS,
  STREAM_SESSION_META_KEY_PREFIX,
  type StreamSessionMeta,
} from './stream-session-tenant-binding.service';
