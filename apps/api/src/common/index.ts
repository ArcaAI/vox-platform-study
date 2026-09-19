/**
 * Barrel for `apps/api/src/common` — cross-cutting primitives.
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
  type StreamSessionBinding,
} from './stream-session-tenant-binding.service';
export { redirect308, API_V1_PREFIX } from './redirect-shim';
export { markPipelineIdDeprecated } from './pipeline-id-deprecation';
export {
  gatewayKeepAliveAgents,
  createGatewayKeepAliveAgents,
  GATEWAY_HTTP_AGENT_MAX_SOCKETS,
  GATEWAY_HTTP_AGENT_MAX_FREE_SOCKETS,
  GATEWAY_HTTP_AGENT_IDLE_SOCKET_TIMEOUT_MS,
  type GatewayKeepAliveAgents,
} from './gateway-http-agent';
