'use client';

import { Card } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import type { TtsPlatformCatalog, TtsVoiceBindings } from '../api';
import { bindingVoiceIds } from './tts-config-fields';

/** Radix SelectItem forbids the empty string; sentinel for "inherit the platform binding". */
const INHERIT = '__inherit__';

/**
 * TASK-506 — per-voice provider bindings editor. Rows = the 4 internal voice
 * ids ∪ any id already bound; one select per catalog provider (empty =
 * inherit the SYSTEM/default binding). Drafts flow up into the form's single
 * OCC save (the PUT persists the FULL merged map as `voiceBindings`).
 */
export function VoiceBindingsEditor({
  uid,
  catalog,
  saved,
  effective,
  drafts,
  onDraftChange,
}: {
  uid: string;
  catalog: TtsPlatformCatalog;
  /** Tenant bindings persisted on the row (configJson.voiceBindings). */
  saved: TtsVoiceBindings;
  /** Effective merged bindings (for the row-id union only — values stay read-only on the resolve card). */
  effective: TtsVoiceBindings | undefined;
  drafts: Record<string, Record<string, string>>;
  onDraftChange: (voiceId: string, provider: string, value: string) => void;
}) {
  const voiceIds = bindingVoiceIds(saved, effective);

  return (
    <Card className="gap-3 p-4 lg:col-span-2">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Voice bindings</h3>
        <p className="text-muted-foreground text-xs">
          Per internal voice id, the provider voice name each engine speaks with. Empty = inherit the platform binding.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {voiceIds.map((voiceId) => (
          <div key={voiceId} className="flex flex-col gap-2">
            <span className="font-mono text-xs font-medium">{voiceId}</span>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {catalog.providers.map((provider) => {
                const id = `${uid}-bind-${voiceId}-${provider.provider}`;
                const value = drafts[voiceId]?.[provider.provider] ?? saved[voiceId]?.[provider.provider] ?? '';
                // A bound voice name missing from the catalog stays selectable (registry drift).
                const orphan = value !== '' && !provider.voices.some((voice) => voice.id === value) ? value : null;
                return (
                    <div key={provider.provider} className="flex flex-col gap-1.5">
                      <Label htmlFor={id} className="text-muted-foreground font-mono text-xs font-medium">
                        {provider.provider}
                      </Label>
                      <Select
                        value={value === '' ? INHERIT : value}
                        onValueChange={(next) => onDraftChange(voiceId, provider.provider, next === INHERIT ? '' : next)}
                      >
                        <SelectTrigger id={id} className="h-8 font-mono text-xs" aria-label={`${provider.provider} voice for ${voiceId}`}>
                          <SelectValue placeholder="inherit" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={INHERIT} className="text-xs">
                            inherit
                          </SelectItem>
                          {orphan ? (
                            <SelectItem value={orphan} className="font-mono text-xs">
                              {orphan}
                            </SelectItem>
                          ) : null}
                          {provider.voices.map((voice) => (
                            <SelectItem key={voice.id} value={voice.id} className="font-mono text-xs">
                              {voice.id}
                              <span className="text-muted-foreground text-xs">({voice.locale})</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
