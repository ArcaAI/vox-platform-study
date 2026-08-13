import { useState } from 'react';
import { useArcaSttProvider } from '@arcaai/vox/compat';

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
export function ProviderSwitch() {
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

  // Which side is live. `usePipeline` is now trustworthy in both directions
  // : the gateway relays `active`/`is_fallback` on the switch frame,
  // and where a backend still omits them the SDK compares the pipeline id
  // itself rather than assuming "fallback". The id comparison this component
  // used to hand-roll now lives in the SDK, so it is gone from here.
  const active = provider.activeProvider;
  const onSelected = provider.usePipeline;

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
  // Still derived from arrival rather than `provider.switchStatus`: the status
  // leaves 'switching' on the `isFallback` flip, which is one event behind what
  // this label is about. The buttons are deliberately never disabled — the SDK
  // guards concurrent switches and both calls are idempotent.
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
