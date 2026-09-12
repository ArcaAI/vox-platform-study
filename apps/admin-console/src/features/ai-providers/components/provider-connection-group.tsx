'use client';

import { useMemo, useState } from 'react';
import { IconPlus } from '@tabler/icons-react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
  connectionIsDefault,
  connectionSlugOf,
  type PlatformDefaultConnection,
  type ProviderConnection,
  type ProviderService,
} from '../api/types';
import { AddConnectionDialog } from './add-connection-dialog';
import { ProviderCredentialCard } from './provider-credential-card';
import type { ProviderMeta } from './provider-meta';

/**
 * TASK-958 D-10 — one vendor, several accounts.
 *
 * A tenant that holds two OpenAI keys had one card and no way to say which key
 * an agent spends. This group is the answer: the provider's DEFAULT connection
 * (what every SYSTEM-catalogue model resolves through, D-3), then each sibling,
 * then the button that adds another.
 *
 * Three properties make it safe while the gateway half is in flight:
 *
 *  - **the canonical card is always rendered.** `slug === provider` is the slug
 *    of every row that exists today AND the row a tenant creates first, so a
 *    provider with no connection still shows the card an admin saves into.
 *  - **the list is advisory, never load-bearing.** A gateway that cannot list
 *    (or does not carry the multiplicity fields yet) yields no siblings, and
 *    the group degrades to exactly the single card it used to be.
 *  - **"default" is read off the row, not inferred from the slug.** Once a
 *    tenant flips the default onto a sibling, the sibling is the badged card and
 *    `openai` is the one offering "Make default".
 */
export function ProviderConnectionGroup({
  service,
  meta,
  tenantId,
  enabled = true,
  platformDefault,
  connections,
}: {
  service: ProviderService;
  meta: ProviderMeta;
  tenantId?: string;
  enabled?: boolean;
  platformDefault?: PlatformDefaultConnection | undefined;
  /** The tenant's whole connection list for this capability, read once per tab. */
  connections: UseQueryResult<ProviderConnection[]>;
}) {
  const [adding, setAdding] = useState(false);
  // The connection the admin just created: its card takes focus on the key
  // field, which is the only thing still missing from it.
  const [created, setCreated] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = Array.isArray(connections.data) ? connections.data : [];
    return all.filter((row) => row.provider === meta.id);
  }, [connections.data, meta.id]);

  /**
   * Every card this group renders, default first, then the canonical slug, then
   * alphabetically — a stable order that does not jump as rows load.
   */
  const cards = useMemo(() => {
    const bySlug = new Map<string, ProviderConnection | null>([[meta.id, null]]);
    for (const row of rows) bySlug.set(connectionSlugOf(row), row);
    return [...bySlug.entries()]
      .map(([slug, row]) => ({ slug, row, isDefault: row ? connectionIsDefault(row) : slug === meta.id }))
      .sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        if (a.slug === meta.id) return -1;
        if (b.slug === meta.id) return 1;
        return a.slug.localeCompare(b.slug);
      });
  }, [rows, meta.id]);

  const multiple = cards.length > 1;

  return (
    <div className="flex flex-col gap-3" role="group" aria-label={`${meta.label} connections`}>
      {cards.map((card) => (
        <ProviderCredentialCard
          key={card.slug}
          service={service}
          meta={meta}
          slug={card.slug}
          connectionName={card.row?.name ?? null}
          defaultBadge={multiple && card.isDefault}
          // The flip is offered only where it means something: a stored sibling
          // that is not already the default.
          canMakeDefault={multiple && !card.isDefault && (card.row?.version ?? 0) > 0}
          autoFocusKey={created === card.slug}
          tenantId={tenantId}
          tier="tenant"
          enabled={enabled}
          platformDefault={card.isDefault ? platformDefault : undefined}
        />
      ))}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setAdding(true)} aria-label={`Add another ${meta.label} connection`}>
          <IconPlus aria-hidden />
          Add another {meta.label} connection
        </Button>
        {/*
          A failed list is said, not swallowed: the group still works (the cards
          above read their own rows), but it cannot show siblings, and an admin
          who created one yesterday deserves to know why it is missing rather
          than to create it twice.
        */}
        {connections.error ? <span className="text-muted-foreground text-xs">Existing connections could not be listed.</span> : null}
      </div>
      <AddConnectionDialog
        service={service}
        meta={meta}
        tenantId={tenantId}
        existingSlugs={cards.map((card) => card.slug)}
        open={adding}
        onOpenChange={setAdding}
        onCreated={setCreated}
      />
    </div>
  );
}
