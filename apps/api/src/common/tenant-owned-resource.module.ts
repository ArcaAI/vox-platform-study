/**
 * `TenantOwnedResourceModule` — TASK-307 W3.2.
 *
 * Wraps the global `TenantOwnedResourceInterceptor` registration so the
 * interceptor's repository / service injections resolve cleanly from the
 * root `AppModule.providers` scope.
 *
 * Why a wrapper module:
 *   - The interceptor injects `TenantBucketRepository`,
 *     `UserVoiceProfileRepository`, `TranscriptionJobRepository` (all from
 *     `CoreDatabaseModule`) and `IConsultationJobService` (from
 *     `ConsultationJobServiceModule`). Feature modules import those, but do
 *     not re-export them — so they are NOT visible at the `AppModule`
 *     provider scope by default.
 *   - Marking this wrapper `@Global()` is unnecessary: the wrapper itself is
 *     imported by `AppModule`, and the `APP_INTERCEPTOR` provider it
 *     registers runs across every request regardless of which feature
 *     module the route belongs to.
 *
 * The wrapper imports `ConsultationJobServiceModule`, the same module
 * `ConsultationModule` already imports. NestJS deduplicates module instances
 * by class identity, so the BullMQ queues / Redis subscribers registered
 * inside that module are NOT instantiated twice.
 */
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConsultationJobServiceModule } from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { TenantOwnedResourceInterceptor } from './tenant-owned-resource.interceptor';

@Module({
  imports: [CoreDatabaseModule, ConsultationJobServiceModule],
  providers: [
    TenantOwnedResourceInterceptor,
    // Register the interceptor as APP_INTERCEPTOR via useExisting so the
    // same instance handles every request — keeps the per-request work to
    // a single Reflector lookup + (optionally) one repository call.
    {
      provide: APP_INTERCEPTOR,
      useExisting: TenantOwnedResourceInterceptor,
    },
  ],
})
export class TenantOwnedResourceModule {}
