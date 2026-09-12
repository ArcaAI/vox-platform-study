import { Injectable, Logger, Optional } from '@nestjs/common';

import { COMPUTE_DEVICE_BY_PROVIDER_KEY } from '../settings-registry/descriptors/metering-compute.descriptors';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { COMPUTE_DEVICES, type ComputeDevice } from './usage-attributes';

/**
 * Which device a self-hosted LLM server runs on (TASK-959 §3.1).
 *
 * Every other service answers this itself — stt from `LoadedModel.device`, tts
 * and nlp from their own settings — and reports it on the wire. `apps/text`
 * cannot: it is stateless per call and there is no `device` field on
 * `ProviderOverride`, on `GenerateRequest`, or on `AiModel` (`computeType` is a
 * PRECISION, not a device). So for the LLM engines the device is SUPPLIED by
 * configuration, and this is the one place that configuration is read.
 *
 * ============================================================================
 * IT NEVER RAISES, AND THAT IS THE DESIGN
 * ============================================================================
 * The descriptor is `failMode: 'open-to-default'` and this resolver is stricter
 * than the registry about what counts as an answer: an unlisted provider, a map
 * that is not a map, a device spelling outside {@link COMPUTE_DEVICES}, or a
 * settings read that throws all resolve to `cpu`.
 *
 * The reason is where it sits. It is called on the EMITTING path, moments
 * before a usage batch is written, and a throw there loses the whole batch —
 * tokens included — to protect a device label. Under-recording is the
 * correctable direction: an implausible CPU figure is visible on the
 * consumption screen and a compensating event fixes history, whereas revenue
 * never emitted is revenue never found. §3.5 states this as an R1 blind spot.
 */
export interface IComputeDeviceResolver {
  /**
   * The device `provider` runs on for `tenantId`.
   *
   * `tenantId` may be `null` for a caller with no tenant in context (a queue
   * job, a boot-time reader); that resolves the platform lane. Asynchronous by
   * contract even though today's cascade is a synchronous cache read — a
   * caller must not have to change when the backing store does.
   */
  resolve(tenantId: string | null, provider: string): Promise<ComputeDevice>;
}

export const IComputeDeviceResolver = Symbol('IComputeDeviceResolver');

/** The answer for anything the map cannot resolve — see the header. */
const FALLBACK_DEVICE: ComputeDevice = 'cpu';

@Injectable()
export class ComputeDeviceResolver implements IComputeDeviceResolver {
  private readonly logger = new Logger(ComputeDeviceResolver.name);

  /** Keys already WARN-logged, so an emitting path logs once, not per request. */
  private readonly warned = new Set<string>();

  constructor(
    /**
     * The `global-kv` cascade: tenant override → SYSTEM row → descriptor
     * default. `@Optional()` so a fixture (or a graph that wires the ledger
     * without the settings registry) degrades to `cpu` rather than failing to
     * construct — the same posture as every other read on this path.
     */
    @Optional() private readonly tenantSettings?: TenantSettingsService,
  ) {}

  async resolve(tenantId: string | null, provider: string): Promise<ComputeDevice> {
    if (!this.tenantSettings) return FALLBACK_DEVICE;

    let map: unknown;
    try {
      map = this.tenantSettings.resolve(COMPUTE_DEVICE_BY_PROVIDER_KEY, tenantId).value;
    } catch (error) {
      this.warnOnce(`read:${provider}`, 'Could not read the compute-device map — metering this call as CPU_SECOND', error);
      return FALLBACK_DEVICE;
    }

    if (!map || typeof map !== 'object' || Array.isArray(map)) return FALLBACK_DEVICE;

    const device = (map as Record<string, unknown>)[provider];
    if (device === undefined || device === null) return FALLBACK_DEVICE;

    // Membership, not shape. A near-miss (`gpu` for `cuda`) would be rejected
    // by `validateUsageAttributes` at emit time — AFTER it had already chosen
    // the unit — and take the whole batch with it.
    if (typeof device !== 'string' || !(COMPUTE_DEVICES as readonly string[]).includes(device)) {
      this.warnOnce(
        `value:${provider}:${String(device)}`,
        `metering.compute.deviceByProvider maps "${provider}" to an unknown device — metering it as CPU_SECOND`,
      );
      return FALLBACK_DEVICE;
    }

    return device as ComputeDevice;
  }

  private warnOnce(dedupeKey: string, message: string, error?: unknown): void {
    if (this.warned.has(dedupeKey)) return;
    this.warned.add(dedupeKey);
    this.logger.warn({
      message,
      key: COMPUTE_DEVICE_BY_PROVIDER_KEY,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
    });
  }
}
