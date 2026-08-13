/**
 * @deprecated Pre-unification module path. The interface, DI token and types
 * moved to `./IProviderConnectionService` (unified provider-connection
 * plane). This shim re-exports them so any lingering deep-path import keeps
 * working for one release; new code imports from `./IProviderConnectionService`
 * (or the package barrel).
 */
export * from './IProviderConnectionService';
