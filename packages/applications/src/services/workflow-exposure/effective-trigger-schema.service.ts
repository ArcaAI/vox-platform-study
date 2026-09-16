import { Injectable, Logger } from '@nestjs/common';
import { ConsultationContextSchemaRepository, ConsultationContextSchemaVersionRepository } from '@arcaai/domains';
import { effectiveTriggerConfig, triggerContextBinding } from './effective-trigger-schema';
import type { ContextSchemaPin, EffectiveTriggerConfig } from './effective-trigger-schema';

/**
 * The ONE reader that turns a compiled trigger's follow-latest binding into the tenant's
 * current pin, so `effectiveTriggerConfig` can stay pure.
 *
 * ## Why a service and not a method on the context-schema service
 *
 * Three call sites need this answer — the consultation dispatcher, the exposure plane's invoke,
 * and the pre-dispatch compatibility check at `open` — and none of them is, or should become, a
 * consumer of the whole context-schema admin surface. What they need is two rows and one
 * derivation, which is what this is.
 *
 * ## Never throws, and that is the contract
 *
 * Dispatch is best-effort by contract: a harness outage, an unreadable schema row or a schema
 * whose pin was withdrawn must never stop a clinician opening a consultation. So every failure
 * here answers `null` — "no pin to follow" — which `effectiveTriggerConfig` reads as "leave the
 * published bytes alone". The run then executes against the schema the workflow was published
 * with, which is precisely the behaviour every follow-latest workflow had before this existed.
 *
 * ## Tenancy
 *
 * `schemaRepository.findById` runs under the caller's CLS tenant through the Prisma tenant-scope
 * extension, and the explicit `tenantId` comparison below is the second lock — the same
 * belt-and-braces `ConsultationContextSchemaService.resolveReference` uses, and for the same
 * reason: a context schema is CLONED into a tenant and never shared from SYSTEM, so a foreign
 * or SYSTEM id is simply not this tenant's pin and must read as absent rather than as a value.
 */
@Injectable()
export class EffectiveTriggerSchemaService {
  private readonly logger = new Logger(EffectiveTriggerSchemaService.name);

  constructor(
    private readonly schemaRepository: ConsultationContextSchemaRepository,
    private readonly versionRepository: ConsultationContextSchemaVersionRepository,
  ) {}

  /**
   * The config a run dispatched NOW should execute against, and the payload schema it will be
   * validated with.
   *
   * A pinned trigger costs no read at all — the binding is answered from the compiled bytes
   * before any repository is touched.
   */
  async resolve(tenantId: string, compiledConfig: unknown): Promise<EffectiveTriggerConfig> {
    const binding = triggerContextBinding(compiledConfig);
    if (!binding.followsLatest || binding.schemaId === null) {
      return effectiveTriggerConfig(compiledConfig, null);
    }
    return effectiveTriggerConfig(compiledConfig, await this.currentPin(tenantId, binding.schemaId));
  }

  /** The tenant's pinned version of one schema, or `null` for every reason it cannot be read. */
  async currentPin(tenantId: string, schemaId: string): Promise<ContextSchemaPin | null> {
    try {
      const schema = await this.schemaRepository.findById(schemaId);
      if (!schema || schema.tenantId !== tenantId || schema.pinnedVersionNumber == null) return null;

      const version = await this.versionRepository.findBySchemaAndVersionNumber(schema.id, schema.pinnedVersionNumber);
      if (!version) return null;

      return { versionNumber: version.versionNumber, definition: version.definition };
    } catch (error) {
      this.logger.warn({
        message: 'Context-schema pin could not be read — a follow-latest trigger runs against the schema its workflow was published with',
        schemaId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
