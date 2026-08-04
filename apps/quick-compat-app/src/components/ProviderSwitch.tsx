import { useState } from 'react';
import { useArcaSttProvider } from '@arcaai/vox/compat';

interface ProviderSwitchProps {
  /** The configured (primary) pipeline id — used to tell the two sides apart. */
  pipelineId: string;
}

/**
 * Quick STT provider switch for a live session.
 *
 * **Selected** = the pipeline id configured on `<ArcaCompatProvider>`.
 * **Default**  = the tenant-admin default STT provider. The gateway resolves it
 * from the tenant's STT config (`effective.fallbackPipelineId`) — HOPE addresses
 * providers BY pipeline id, so the id changing on switch is the provider
 * changing, not a jump to some unrelated pipeline.
 *
 * Works in both directions and at any time:
 *  - BEFORE capture starts the pick is remembered and applied at `audio.start`;
 *  - DURING a live session the SDK switches the running stream in place.
 *
 * Switching back to the selected pipeline additionally requires
 * `enableProviderSwitch: true` on the provider (see `App.tsx`).
 */
export function ProviderSwitch({ pipelineId }: ProviderSwitchProps) {
  const [error, setError] = useState<string | null>(null);
  const [lastSwitch, setLastSwitch] = useState<string | null>(null);
  /** The side the user last asked for, so "switching…" can be cleared by arrival. */
  const [requested, setRequested] = useState<'selected' | 'default' | null>(null);

  const provider = useArcaSttProvider({
    onProviderSwitched: (info) => {
      setError(null);
      setLastSwitch(`${info.reason === 'auto' ? 'auto-switched' : 'switched'} → ${info.toPipeline.name ?? info.toPipeline.id}`);
    },
    onSwitchFailed: (err) => setError(err.message),
  });

  // Which side is live, decided by the pipeline ID rather than the SDK's
  // `isFallback` flag.
  //
  // WHY: the SDK derives `isFallback` from the backend's switch-confirmation
  // frame and DEFAULTS IT TO TRUE when the frame carries neither `isFallback`
  // nor `active`. This gateway's frame carries neither, so a switch BACK to the
  // selected pipeline is still reported as `isFallback=true` — the toggle would
  // stick on "Default" forever even though the stream really did move back
  // (observed: `provider switched … to=…0117, isFallback=true`).
  //
  // The id is unambiguous, so compare that. Before a live session exists there
  // is no id yet, and the hook's pre-start view is authoritative.
  const active = provider.activeProvider;
  const onSelected = active ? active.pipelineId === pipelineId : provider.usePipeline;

  // Both calls reject with an ErrorInfo on failure; `onSwitchFailed` already
  // surfaces it, so the catch here only stops the unhandled rejection.
  const select = (target: 'selected' | 'default') => {
    setError(null);
    setRequested(target);
    const run = target === 'selected' ? provider.switchToPipeline() : provider.switchToDefault();
    void run.catch(() => undefined);
  };

  // "Switching" means "the live pipeline is not the one you asked for yet".
  //
  // `provider.switchStatus` cannot be used for this: it only leaves 'switching'
  // when the `isFallback` flip fires, and that flip never happens on the way
  // back to the selected pipeline (same defaulting bug as above) — so the label
  // would stick forever. The buttons are deliberately never disabled for the
  // same reason; the SDK guards concurrent switches and both calls are
  // idempotent.
  const arrived = requested === null || (requested === 'selected') === onSelected;
  const busy = !arrived;

  return (
    <>
      <div className="row">
        <span className="muted">STT provider</span>

        <div className="segmented" role="group" aria-label="STT provider">
          <button aria-pressed={onSelected} onClick={() => select('selected')}>
            Selected
          </button>
          <button aria-pressed={!onSelected} onClick={() => select('default')}>
            Default
          </button>
        </div>

        {busy ? <span className="muted">switching…</span> : null}
        {!busy && error ? <span className="error">{error}</span> : null}
        {!busy && !error && lastSwitch ? <span className="muted">{lastSwitch}</span> : null}
      </div>

      {/*
        The SDK's own view of what is transcribing RIGHT NOW. Null until a live
        backend streaming session exists — and while it is null a switch is only
        recorded as a pre-start preference rather than applied to a running
        stream, so showing it keeps the toggle from looking more authoritative
        than it is.
      */}
      <p className="muted">
        {active
          ? `live: ${active.name ?? active.pipelineId} (${onSelected ? 'selected pipeline' : 'tenant default provider'})`
          : 'no live session — selection applies when you press Start'}
      </p>
    </>
  );
}
