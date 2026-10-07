'use client';

import { IconBulb } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { EmptyState } from '@/shared/state/empty-state';
import { formatRelativeTime } from '@/shared/format';
import { useDismissSuggestion, usePinResidencyModel } from '../api';
import type { ResidencyCatalogueModel, ResidencyServiceGroup, ResidencySuggestion } from '../api/types';
import { suggestionVerb } from './residency-display';

type Target = { service: ResidencyServiceGroup; model: ResidencyCatalogueModel };

function findTarget(services: ResidencyServiceGroup[], suggestion: ResidencySuggestion): Target | null {
  const service = services.find((candidate) => candidate.service === suggestion.service);
  const model = service?.models.find((candidate) => candidate.modelRef === suggestion.modelRef);
  return service && model ? { service, model } : null;
}

export interface SuggestionsPanelProps {
  suggestions: ResidencySuggestion[];
  /** The catalogue's services — Apply resolves the suggestion's row from them. */
  services: ResidencyServiceGroup[];
  onApplyLoad: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
  onApplyUnload: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
  /** Injectable for tests; defaults to the render time. */
  now?: Date;
}

function SuggestionRow({
  suggestion,
  services,
  onApplyLoad,
  onApplyUnload,
  now,
}: Omit<SuggestionsPanelProps, 'suggestions'> & { suggestion: ResidencySuggestion }) {
  const dismiss = useDismissSuggestion();
  const pin = usePinResidencyModel();
  const target = findTarget(services, suggestion);
  const verb = suggestionVerb(suggestion.action);
  const name = target?.model.name ?? suggestion.modelRef;
  const isPin = suggestion.action === 'pin' || suggestion.action === 'unpin';
  const canApply = isPin || ((suggestion.action === 'load' || suggestion.action === 'unload') && target !== null);
  const knownAction = isPin || suggestion.action === 'load' || suggestion.action === 'unload';

  function apply() {
    if (isPin) {
      const pinned = suggestion.action === 'pin';
      pin.mutate(
        { service: suggestion.service, modelRef: suggestion.modelRef, pinned },
        {
          onSuccess: () => toast.success(`${pinned ? 'Pinned' : 'Unpinned'} ${name}.`),
          onError: (error) => toast.error(error instanceof Error && error.message ? error.message : `Couldn't ${pinned ? 'pin' : 'unpin'} ${name}.`),
        },
      );
      return;
    }
    if (!target) return;
    if (suggestion.action === 'load') onApplyLoad(target.service, target.model);
    else onApplyUnload(target.service, target.model);
  }

  function handleDismiss() {
    dismiss.mutate(suggestion.id, {
      onSuccess: () => toast.success('Recommendation dismissed.'),
      onError: (error) => toast.error(error instanceof Error && error.message ? error.message : "Couldn't dismiss the recommendation."),
    });
  }

  const seen = `First seen ${formatRelativeTime(suggestion.firstSeenAt, now)} · last confirmed ${formatRelativeTime(suggestion.at, now)}`;

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{verb}</Badge>
        <span className="min-w-0 font-medium break-words">{name}</span>
      </div>
      <p className="text-sm">{suggestion.text}</p>
      <p className="text-muted-foreground text-xs">{suggestion.repeats > 1 ? `${seen} · ×${suggestion.repeats}` : seen}</p>
      <div className="flex flex-wrap items-center gap-2">
        {suggestion.applied ? (
          <Badge variant="outline">Applied</Badge>
        ) : knownAction ? (
          <Button size="sm" disabled={!canApply || pin.isPending} onClick={apply}>
            {pin.isPending ? <Spinner /> : null}
            Apply
            <span className="sr-only">
              : {verb} {name}
            </span>
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={dismiss.isPending} onClick={handleDismiss}>
          {dismiss.isPending ? <Spinner /> : null}
          Dismiss
          <span className="sr-only">
            : {verb} {name}
          </span>
        </Button>
      </div>
      {!suggestion.applied && knownAction && !canApply ? (
        <p className="text-muted-foreground text-xs">This model is no longer in the catalogue.</p>
      ) : null}
    </li>
  );
}

/**
 * Recommendations (artboard 01, F4): one standing row per model + action, with
 * first seen / last confirmed / repeats instead of a flood of duplicates. It
 * sits BESIDE the content, never in the pinned top region (it used to push the
 * tables ~8000 px down). Apply routes load/unload through the same dialogs the
 * rows use; pin/unpin calls the running service directly.
 */
export function SuggestionsPanel({ suggestions, services, onApplyLoad, onApplyUnload, now }: SuggestionsPanelProps) {
  return (
    <Card role="complementary" aria-labelledby="residency-recommendations-heading" className="gap-0 overflow-hidden p-0">
      <div className="border-b px-4 py-3">
        <h2 id="residency-recommendations-heading" className="text-base font-medium">
          Recommendations ({suggestions.length})
        </h2>
        <p className="text-muted-foreground mt-1 text-xs">One row per model and action. Repeats update &ldquo;last confirmed&rdquo;.</p>
      </div>
      {suggestions.length === 0 ? (
        <EmptyState icon={IconBulb} title="No recommendations" description="The policy engine lists what it would load or unload here." />
      ) : (
        <ul className="divide-y" aria-label="Recommendations">
          {suggestions.map((suggestion) => (
            <SuggestionRow
              key={suggestion.id}
              suggestion={suggestion}
              services={services}
              onApplyLoad={onApplyLoad}
              onApplyUnload={onApplyUnload}
              now={now}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
