'use client';

import { useState } from 'react';
import { IconCpu, IconPlus, IconShieldLock } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { useSession } from '@/shared/auth';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useRuntimeProfiles } from '../api/hooks';
import { ALL_KNOBS, PROVIDER_DEFAULT_SLUG, type AiRuntimeProfile } from '../api/types';
import { RuntimeProfileDrawer, type RuntimeProfileTarget } from './runtime-profile-drawer';

/** How many knobs of this row carry an opinion — the density an admin scans for. */
function knobCount(profile: AiRuntimeProfile): number {
  const scalars = ALL_KNOBS.filter((spec) => profile[spec.name] !== null && profile[spec.name] !== undefined).length;
  return scalars + (profile.extraJson ? 1 : 0);
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" aria-hidden>
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * A minimal "open a (provider, model) pair" form.
 *
 * There is no catalog route for the pairs that COULD have a profile — a profile
 * is addressed by two free strings, and a pair with no row reads back as a
 * `version: 0` placeholder rather than a 404. So creating is just addressing:
 * name the pair and the editor opens on it, configured or not.
 */
function OpenPairDrawer({ open, onOpenChange, onOpen }: { open: boolean; onOpenChange: (open: boolean) => void; onOpen: (target: RuntimeProfileTarget) => void }) {
  const [provider, setProvider] = useState('');
  const [modelSlug, setModelSlug] = useState('');
  const trimmedProvider = provider.trim();

  return (
    <DetailDrawer
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setProvider('');
          setModelSlug('');
        }
        onOpenChange(next);
      }}
      title="Open a runtime profile"
      meta={<span>Address any (provider, model) pair &mdash; an unconfigured pair opens empty.</span>}
      footer={
        <Button
          size="sm"
          disabled={trimmedProvider === ''}
          onClick={() => {
            onOpen({ provider: trimmedProvider, modelSlug: modelSlug.trim() });
            setProvider('');
            setModelSlug('');
          }}
        >
          Open editor
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rp-provider">
            Provider <span aria-hidden>*</span>
          </Label>
          <Input
            id="rp-provider"
            value={provider}
            placeholder="lm-studio"
            onChange={(event) => setProvider(event.target.value)}
            aria-describedby="rp-provider-help"
            className="font-mono"
          />
          <p id="rp-provider-help" className="text-muted-foreground text-xs">
            The serving provider identifier, e.g. <span className="font-mono">lm-studio</span>, <span className="font-mono">ollama</span>,{' '}
            <span className="font-mono">azure</span>.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rp-model">Model slug</Label>
          <Input
            id="rp-model"
            value={modelSlug}
            placeholder="gemma-4-e2b-it-qat"
            onChange={(event) => setModelSlug(event.target.value)}
            aria-describedby="rp-model-help"
            className="font-mono"
          />
          <p id="rp-model-help" className="text-muted-foreground text-xs">
            Leave empty to edit the PROVIDER-LEVEL DEFAULT — the row every model under this provider inherits from.
          </p>
        </div>
      </div>
    </DetailDrawer>
  );
}

/**
 * AI runtime profiles (/ai-runtime-profiles, tier 10-19, SUPER_ADMIN only).
 *
 * The platform's hyperparameter, capacity and timing plane. `admin/ai-runtime-profiles`
 * has shipped five operations — list, read row, resolve cascade, upsert,
 * delete — with NO feature folder and NO screen, so temperature, context
 * length, concurrency, TPM/RPM ceilings and request timeouts were reachable
 * only by hand-rolled HTTP. This is the button.
 *
 * Scope note: every row is pinned to the reserved SYSTEM tenant by
 * `AiRuntimeProfileService` (it refuses a non-SYSTEM target outright) and the
 * route is `manage:all`. So this is a `(global)` tier 10-19 screen with no
 * working-tenant dependency, even though the response DTO carries a `tenantId`
 * field — the field is real, its range is one value.
 */
export function RuntimeProfilesScreen() {
  const session = useSession();
  const isElevated = session.data?.isElevated ?? false;
  const profilesQuery = useRuntimeProfiles(isElevated);

  const [target, setTarget] = useState<RuntimeProfileTarget | null>(null);
  const [openPair, setOpenPair] = useState(false);

  const header = (
    <PageHeader
      title="AI runtime profiles"
      meta={<span>platform hyperparameters, capacity and timing &middot; SYSTEM tenant &middot; optimistic concurrency on every write</span>}
      actions={
        isElevated ? (
          <Button size="sm" onClick={() => setOpenPair(true)}>
            <IconPlus aria-hidden />
            Open profile
          </Button>
        ) : null
      }
    />
  );

  if (session.isPending) {
    return (
      <ScreenTemplate header={header}>
        <ListSkeleton />
      </ScreenTemplate>
    );
  }

  if (!isElevated) {
    return (
      <ScreenTemplate header={header}>
        <EmptyState
          icon={IconShieldLock}
          title="Super Admins only"
          description="Runtime profiles are platform-level configuration on the SYSTEM tenant. Only super administrators can view or edit them."
        />
      </ScreenTemplate>
    );
  }

  return (
    <ScreenTemplate
      header={header}
      footer={
        <StatusFooter
          start={profilesQuery.data ? <span>{profilesQuery.data.length} configured row(s)</span> : null}
          end={
            <span aria-hidden className="font-mono">
              GET /admin/ai-runtime-profiles
            </span>
          }
        />
      }
    >
      {profilesQuery.isPending ? (
        <ListSkeleton />
      ) : profilesQuery.error ? (
        <ErrorState error={profilesQuery.error} onRetry={() => void profilesQuery.refetch()} />
      ) : profilesQuery.data.length === 0 ? (
        <EmptyState
          icon={IconCpu}
          title="No runtime profiles configured"
          description="Nothing is injected today — every provider and model runs on the consuming service's own defaults. Open a profile to set hyperparameters, concurrency, rate limits or timeouts."
          action={
            <Button size="sm" onClick={() => setOpenPair(true)}>
              <IconPlus aria-hidden />
              Open profile
            </Button>
          }
        />
      ) : (
        <div className="rounded-md border">
          <Table aria-label="AI runtime profiles">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Provider</TableHead>
                <TableHead scope="col">Model</TableHead>
                <TableHead scope="col">Knobs set</TableHead>
                <TableHead scope="col">Version</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profilesQuery.data.map((profile) => (
                <TableRow key={`${profile.provider}::${profile.modelSlug}`}>
                  <TableCell className="font-mono text-xs">{profile.provider}</TableCell>
                  <TableCell>
                    {profile.modelSlug === PROVIDER_DEFAULT_SLUG ? (
                      <Badge variant="secondary">Provider default</Badge>
                    ) : (
                      <span className="font-mono text-xs">{profile.modelSlug}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{knobCount(profile)}</TableCell>
                  <TableCell className="font-mono text-xs">v{profile.version}</TableCell>
                  <TableCell>
                    {/* Accessible name in `aria-label` rather than an sr-only
                        span: one DOM occurrence, and it still starts with the
                        visible word for label-in-name (WCAG 2.5.3). */}
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Edit ${profile.provider} ${profile.modelSlug || 'provider default'}`}
                      onClick={() => setTarget({ provider: profile.provider, modelSlug: profile.modelSlug })}
                    >
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <OpenPairDrawer
        open={openPair}
        onOpenChange={setOpenPair}
        onOpen={(next) => {
          setOpenPair(false);
          setTarget(next);
        }}
      />
      <RuntimeProfileDrawer target={target} open={target !== null} onOpenChange={(next) => !next && setTarget(null)} />
    </ScreenTemplate>
  );
}
