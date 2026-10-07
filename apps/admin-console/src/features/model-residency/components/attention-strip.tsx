import { IconAlertOctagon, IconAlertTriangle } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import type { ResidencyCatalogueModel, ResidencyServiceGroup } from '../api/types';
import { splitDeviceLabel, type AttentionItem } from './residency-display';

export interface AttentionStripProps {
  items: AttentionItem[];
  onLink: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
  onLoad: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
}

function AttentionTag({ item }: { item: AttentionItem }) {
  // The tag is text + icon: severity is never carried by colour alone (WCAG 1.4.1).
  if (item.severity === 'critical') {
    return (
      <Badge variant="destructive" data-testid="attention-tag" className="min-w-20 uppercase">
        <IconAlertOctagon aria-hidden />
        {item.tag}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" data-testid="attention-tag" className="border-warning-strong/50 text-warning-strong min-w-20 uppercase">
      <IconAlertTriangle aria-hidden />
      {item.tag}
    </Badge>
  );
}

function AttentionAction({ item, onLink, onLoad }: { item: AttentionItem } & Omit<AttentionStripProps, 'items'>) {
  if (item.kind === 'over_headroom' && item.device) {
    return (
      <Button asChild variant="outline" size="sm">
        <a href={`#residency-gpu-${item.device.id}`} onClick={() => document.getElementById(`residency-gpu-${item.device!.id}`)?.focus()}>
          See what is on {splitDeviceLabel(item.device.label).title}
        </a>
      </Button>
    );
  }
  const { service, model } = item;
  if (!service || !model || !service.controllable) return null;
  if (item.kind === 'mismatch') {
    return (
      <Button variant="outline" size="sm" onClick={() => onLink(service, model)}>
        Link to catalogue…
      </Button>
    );
  }
  if (item.kind === 'live_path_not_loaded' && model.actions.includes('load')) {
    return (
      <Button variant="outline" size="sm" onClick={() => onLoad(service, model)}>
        Load…
      </Button>
    );
  }
  return null;
}

/**
 * "Needs attention" (artboard 01): derived client-side from the catalogue
 * (`deriveAttentionItems`) and already risk-ordered. Hidden when empty — a
 * calm screen does not carry an empty alarm panel.
 */
export function AttentionStrip({ items, onLink, onLoad }: AttentionStripProps) {
  if (items.length === 0) return null;
  return (
    <Card role="region" aria-labelledby="residency-attention-heading" className="gap-0 overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 id="residency-attention-heading" className="text-base font-medium">
          Needs attention ({items.length})
        </h2>
        <span className="text-muted-foreground text-xs">Ordered by risk to live consultations</span>
      </div>
      <ul className="divide-y">
        {items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <AttentionTag item={item} />
            <div className="min-w-0 flex-[1_1_24rem]">
              <p className="font-medium break-words">{item.title}</p>
              <p className="text-muted-foreground text-sm">{item.body}</p>
            </div>
            <AttentionAction item={item} onLink={onLink} onLoad={onLoad} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
