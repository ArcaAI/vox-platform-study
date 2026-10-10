'use client';

/**
 * TASK-1059 C-02 — the lifecycle fields of the consultation response (approval, close, reopen,
 * recordability, encounters, activity clock, caller reference, spoken language). Every field is
 * optional on the wire (an older gateway or a legacy row omits it), so a row whose value is absent
 * or legitimately empty is not rendered at all. Identifiers stay as the API gives them; nothing
 * here is patient content.
 */

import type { ReactNode } from 'react';
import { formatDateTime } from '@/shared/format';
import type { Consultation } from '../api/types';

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm break-all">{children}</dd>
    </div>
  );
}

/** `new-visit` / `CLOSED_COMPLETE` -> `New visit` / `Closed complete`. */
export function humanizeToken(value: string): string {
  const spaced = value.replace(/[-_]+/g, ' ').trim().toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

function Time({ value }: { value: string }) {
  return (
    <span title={value} className="tabular-nums">
      {formatDateTime(value)}
    </span>
  );
}

const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

/** Extra `<dl>` rows for the drawer's meta grid. Renders nothing for fields the API did not send. */
export function ConsultationLifecycleMeta({ consultation }: { consultation: Consultation }) {
  const { approval, closedReason, closedAt, reopenCount, reopenAllowed, recordable, currentEncounterSeq, lastActivityAt, autoCloseAt, externalRef, language } =
    consultation;
  return (
    <>
      {approval ? (
        <MetaItem label="Approved">
          <Time value={approval.approvedAt} />
          <span className="text-muted-foreground block font-mono text-xs">
            by {approval.approvedBy} {'·'} {approval.itemCount} {approval.itemCount === 1 ? 'item' : 'items'}
          </span>
        </MetaItem>
      ) : null}
      {closedReason ? (
        <MetaItem label="Closed">
          {humanizeToken(closedReason)}
          {closedAt ? (
            <>
              {' · '}
              <Time value={closedAt} />
            </>
          ) : null}
        </MetaItem>
      ) : null}
      {reopenCount ? <MetaItem label="Reopened">{reopenCount === 1 ? 'Once' : `${reopenCount} times`}</MetaItem> : null}
      {reopenAllowed !== undefined ? <MetaItem label="Reopen allowed">{yesNo(reopenAllowed)}</MetaItem> : null}
      {recordable !== undefined ? <MetaItem label="Recordable">{yesNo(recordable)}</MetaItem> : null}
      {currentEncounterSeq !== undefined ? <MetaItem label="Current encounter">{`#${currentEncounterSeq}`}</MetaItem> : null}
      {lastActivityAt ? (
        <MetaItem label="Last activity">
          <Time value={lastActivityAt} />
        </MetaItem>
      ) : null}
      {autoCloseAt ? (
        <MetaItem label="Auto-closes">
          <Time value={autoCloseAt} />
        </MetaItem>
      ) : null}
      {externalRef ? (
        <MetaItem label="External reference">
          <span className="font-mono text-xs">{externalRef}</span>
        </MetaItem>
      ) : null}
      {language ? (
        <MetaItem label="Spoken language">
          <span className="font-mono text-xs">{language}</span>
        </MetaItem>
      ) : null}
    </>
  );
}

/** The encounters of a chained (multi-visit) consultation; hidden when there are none. */
export function ConsultationEncountersSection({ consultation }: { consultation: Consultation }) {
  const encounters = consultation.encounters ?? [];
  if (encounters.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-sm font-medium">{`Encounters (${encounters.length})`}</h3>
      <ul className="flex flex-col">
        {encounters.map((encounter) => (
          <li key={encounter.seq} className="flex flex-wrap items-baseline justify-between gap-x-3 border-b py-1.5 text-sm last:border-0">
            <span>
              #{encounter.seq} {'·'} {humanizeToken(encounter.visitType)}
              {encounter.externalRef ? <span className="text-muted-foreground font-mono text-xs">{` · ${encounter.externalRef}`}</span> : null}
            </span>
            <span className="text-muted-foreground text-xs">
              <Time value={encounter.startedAt} />
              {encounter.endedAt ? (
                <>
                  {' – '}
                  <Time value={encounter.endedAt} />
                </>
              ) : (
                ' · in progress'
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
