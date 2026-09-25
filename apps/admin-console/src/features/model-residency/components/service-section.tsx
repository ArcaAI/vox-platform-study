import { IconAlertTriangle, IconServerOff } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { EmptyState } from '@/shared/state/empty-state';
import type { ResidencyCatalogueModel, ResidencyDevice, ResidencyServiceGroup } from '../api/types';
import { formatModelStatus, formatUsedBy, primaryRowAction, primaryRowActionLabel } from './residency-display';

function ModelActionCell({
  service,
  model,
  onLoad,
  onUnload,
  onOpenDrawer,
}: {
  service: ResidencyServiceGroup;
  model: ResidencyCatalogueModel;
  onLoad: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
  onUnload: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
  onOpenDrawer: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
}) {
  // `service.controllable` is false for a service with no control API
  // (stt-worker: Prometheus-only) — its rows carry no load/unload/reload in
  // `actions` either, but gate on the explicit flag rather than an implied
  // empty array so a future data gap fails safe (no action button) instead
  // of silently offering one that would 404.
  const action = service.controllable ? primaryRowAction(model.actions) : null;
  // A model resident but not in the `AiModel` catalogue has no usage, no keep
  // policy to edit and nothing for the drawer to show — no Details link.
  const hasCatalogueEntry = model.aiModelId !== null;
  return (
    <span className="flex items-center justify-end gap-2">
      {model.status === 'loading' || model.status === 'unloading' ? <Spinner className="size-4" /> : null}
      {action === 'load' ? (
        <Button size="sm" onClick={() => onLoad(service, model)}>
          {primaryRowActionLabel('load')}
        </Button>
      ) : null}
      {action === 'unload' ? (
        <Button size="sm" variant="outline" onClick={() => onUnload(service, model)}>
          {primaryRowActionLabel('unload')}
        </Button>
      ) : null}
      {action === 'reload' ? (
        <Button size="sm" variant="outline" onClick={() => onOpenDrawer(service, model)}>
          {primaryRowActionLabel('reload')}
        </Button>
      ) : null}
      {hasCatalogueEntry ? (
        <Button size="sm" variant="ghost" onClick={() => onOpenDrawer(service, model)}>
          Details
        </Button>
      ) : null}
    </span>
  );
}

export interface ServiceSectionProps {
  service: ResidencyServiceGroup;
  devices: ResidencyDevice[];
  onLoad: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
  onUnload: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
  onOpenDrawer: (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;
}

/**
 * One workload's section (ticket §13.2 — "catalogue-first, grouped by
 * service"): every self-hosted model this service can run, loaded or not,
 * with a plain-language status, who uses it, its keep policy, and the ONE
 * primary action the catalogue offers for it right now.
 */
export function ServiceSection({ service, devices, onLoad, onUnload, onOpenDrawer }: ServiceSectionProps) {
  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">{service.label}</h2>
        <span className="text-muted-foreground text-xs">
          {service.models.length} model{service.models.length === 1 ? '' : 's'} &middot; {service.loadedCount} loaded
        </span>
        {service.runsOn === 'cpu' ? <Badge variant="outline">Runs on CPU</Badge> : null}
        {!service.controllable ? <Badge variant="outline">Read-only &middot; no control API</Badge> : null}
      </div>

      {!service.reachable ? (
        <div role="alert" className="border-destructive/40 bg-destructive/10 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <IconAlertTriangle aria-hidden className="text-destructive size-4 shrink-0" />
          <span className="text-destructive">{service.label} did not answer. Residency for this service is unknown right now.</span>
        </div>
      ) : service.models.length === 0 ? (
        <EmptyState icon={IconServerOff} title="No self-hosted models for this service" />
      ) : (
        <div className="rounded-md border">
          <Table aria-label={`${service.label} models`}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Model</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Used by</TableHead>
                <TableHead scope="col">Keep policy</TableHead>
                <TableHead scope="col" className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {service.models.map((model) => (
                <TableRow key={`${service.service}::${model.modelRef}`}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{model.aiModelId ? model.name : model.modelRef}</span>
                      {model.aiModelId ? (
                        <span className="text-muted-foreground font-mono text-xs">{model.slug}</span>
                      ) : (
                        <span className="text-muted-foreground text-xs">Not in the model catalogue</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span>{formatModelStatus(model, devices)}</span>
                      {model.usage.liveConsultation ? <Badge variant="secondary">Live consultations</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell>{formatUsedBy(model.usage)}</TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{model.keepPolicy.label}</span>
                      <span className="text-muted-foreground text-xs">{model.keepPolicy.reason}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <ModelActionCell service={service} model={model} onLoad={onLoad} onUnload={onUnload} onOpenDrawer={onOpenDrawer} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}
