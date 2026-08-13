-- Reconcile the DB `ResourceType` enum with the application enum
-- (same pattern as the TenantTtsConfig precedent) so `AuditLog`
-- writes from TenantIdpConfigService / FederatedAuthService's
-- `broadcastSysEvent(...)` calls don't fail with "Invalid value for argument
-- `resourceType`". Values are not used within this migration.

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'TenantIdentityProvider';

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'FederatedIdentity';
