/**
 * TASK-1005 — at most ONE model load in flight per PHYSICAL GPU, across every
 * service the controller commands.
 *
 * Why the controller, and not each agent: the agents measure a load's
 * footprint as their device's free-memory delta, and on a time-sliced card
 * that delta also contains whatever a CO-TENANT pod loaded at the same moment
 * — which no agent can see. Serialising loads per physical card here is what
 * makes every measured footprint attributable (plan D-2), and it keeps two
 * large loads from racing each other into a CUDA OOM that takes the card-mates
 * down with them (§9).
 *
 * LM Studio's daemon splits a model across both cards, so its loads claim
 * both. A host-CPU pool (`cpu:*`) is not gated: nlp serialises its own loads
 * and measures its own RSS delta.
 *
 * PER PROCESS. A second gateway replica would hold its own gate — see the
 * controller's RISKS note; today the gateway runs one replica.
 */
export class PhysicalGpuLoadGate {
  private readonly held = new Map<string, string>();

  /** Claim every GPU in `devices` for `holder`, or none of them. Synchronous, so check-and-claim cannot interleave. */
  tryAcquire(devices: readonly string[], holder: string): boolean {
    const gpus = devices.filter(isGpu);
    if (gpus.some((id) => this.held.has(id) && this.held.get(id) !== holder)) return false;
    for (const id of gpus) this.held.set(id, holder);
    return true;
  }

  /** Poll `tryAcquire` for at most `maxWaitMs` (the `residency.admission.maxWaitMs` bound). */
  async waitAcquire(devices: readonly string[], holder: string, maxWaitMs: number, pollMs = 250): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, maxWaitMs);
    for (;;) {
      if (this.tryAcquire(devices, holder)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    }
  }

  /** Release every GPU `holder` claimed. Idempotent. */
  release(holder: string): void {
    for (const [id, owner] of this.held) if (owner === holder) this.held.delete(id);
  }

  holderOf(device: string): string | undefined {
    return this.held.get(device);
  }

  /** The GPUs currently claimed, with their holders. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.held);
  }
}

function isGpu(device: string): boolean {
  return device.startsWith('gpu');
}
