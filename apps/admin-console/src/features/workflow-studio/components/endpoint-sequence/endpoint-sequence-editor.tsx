'use client';

/**
 * (D-10) — the endpoint-sequence ORDERING editor.
 *
 * ## What this closes
 *
 * The sequence that runs before a consultation closes used to be a code literal
 * (`endingActionsBase = hasStreamAudio ? ['livedoc.stop', 'harness.finalize'] : ['harness.finalize']`)
 * whose only tenant-facing control was an agent's `neverActions` — a lever that could SUBTRACT
 * and nothing else. This is the surface where an admin ORDERS and EXTENDS it instead.
 *
 * ## Why buttons and not drag
 *
 * Reorder is Move-up / Move-down `<button>`s, not a drag handle. That is the same choice
 * `GraphListEditor` and `EdgeEditor` already made in this feature and for the same reason: WCAG
 * 2.5.7 requires a single-pointer alternative to any drag, and a list of five items does not earn
 * the a11y surface a drag-and-drop implementation costs. Each control names the step it moves, so
 * a screen-reader user hears "Move Lock every document up" rather than five identical "Move up".
 *
 * ## Why the ORDER is presented as the content, not a detail
 *
 * Every row carries its rationale, because ordering this list is a clinical-safety decision and
 * the consequences are not guessable from the labels. Two in particular:
 *
 * * `summary.finalize` locks EVERY document — placing it before the step that writes the note
 *   locks an empty one;
 * * `feedback.capture` is the only path that promotes a clinician-accepted transcript correction,
 *   and it belongs last, because a feedback failure must never cost an already-finalized note.
 *
 * ## Scope
 *
 * The key is `maxScope: 'tenant'`, so the editor writes the platform row (`system`) or the
 * working tenant's override (`tenant`). The read is issued at the SAME scope as the write for a
 * non-obvious reason recorded in `endpoint-sequence.ts`: the two scopes are two rows with two
 * ETags, and preconditioning a tenant write on the platform row's version is a permanent 412.
 */

import { useMemo, useState } from 'react';
import { IconAlertTriangle, IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Spinner,
} from '@arcaai/ui';
import { IconListNumbers } from '@tabler/icons-react';
import { toast } from 'sonner';
import {
  ENDPOINT_ACTION_HINTS,
  ENDPOINT_ACTION_KEYS,
  ENDPOINT_ACTION_LABELS,
  isEndpointOrderInverted,
  useEndpointSequence,
  usePutEndpointSequence,
  type EndpointActionKey,
} from '../../api';

export interface EndpointSequenceEditorProps {
  /** `system` edits the platform default; `tenant` edits the working tenant's override. */
  scope: 'system' | 'tenant';
}

/** Only the closed vocabulary survives — a stored key the resolver would drop is not shown. */
function normalize(value: unknown): EndpointActionKey[] {
  if (!Array.isArray(value)) return [];
  const known = new Set<string>(ENDPOINT_ACTION_KEYS);
  const seen = new Set<string>();
  return value.filter((entry): entry is EndpointActionKey => {
    if (typeof entry !== 'string' || !known.has(entry) || seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });
}

function move(sequence: EndpointActionKey[], index: number, direction: -1 | 1): EndpointActionKey[] {
  const target = index + direction;
  if (target < 0 || target >= sequence.length) return sequence;
  const next = [...sequence];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function EndpointSequenceEditor({ scope }: EndpointSequenceEditorProps) {
  const query = useEndpointSequence(scope);
  const save = usePutEndpointSequence();

  const stored = useMemo(() => normalize(query.data?.data.value), [query.data]);
  const storedKey = stored.join(' ');
  const [toAdd, setToAdd] = useState('');

  /**
   * The draft, reset DURING RENDER when a different server value arrives — React's
   * "adjusting state when a prop changes" recipe, not a `useEffect`.
   *
   * An effect would be the obvious shape and is the wrong one twice over: it renders the stale
   * order once before correcting it, and `react-hooks/set-state-in-effect` refuses it outright.
   * Comparing a stored KEY here re-renders immediately with no intermediate paint.
   *
   * The key is the SERIALISED sequence rather than the array identity, which is the load-bearing
   * part: TanStack hands back a fresh array on every refetch, so identity-keyed resync would
   * discard an admin's in-progress reorder every time the query refocused.
   */
  const [draft, setDraft] = useState<{ key: string; sequence: EndpointActionKey[] }>({ key: storedKey, sequence: stored });
  if (draft.key !== storedKey) setDraft({ key: storedKey, sequence: stored });
  const sequence = draft.sequence;
  const setSequence = (next: EndpointActionKey[] | ((current: EndpointActionKey[]) => EndpointActionKey[])) =>
    setDraft((current) => ({ key: current.key, sequence: typeof next === 'function' ? next(current.sequence) : next }));

  const available = ENDPOINT_ACTION_KEYS.filter((key) => !sequence.includes(key));
  const dirty = sequence.join(' ') !== storedKey;
  const source = query.data?.data.source;

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-48" />
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  const onSave = async () => {
    try {
      await save.mutateAsync({ value: sequence, scope, etag: query.data?.etag ?? null });
      toast.success('Endpoint sequence saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the endpoint sequence');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">Runs in this order when a consultation closes</h2>
        {source ? (
          <Badge variant={source === 'code-default' ? 'outline' : 'secondary'}>
            {source === 'code-default' ? 'Platform default (nothing saved yet)' : source === 'system' ? 'Platform value' : 'Tenant override'}
          </Badge>
        ) : null}
      </div>

      {/*
        The ORDERING invariant, warned about BEFORE the save. Advisory by design: the enforcement
        is the descriptor's `validate` in the settings write lane, which refuses this order with a
        400 — a client that were the only guard would be no guard at all (the same key is
        writable from the generic settings-registry editor and from the API). Read off the DRAFT,
        not the stored value, so it tracks the order the admin is building.
      */}
      {isEndpointOrderInverted(sequence) ? (
        <Alert variant="destructive">
          <IconAlertTriangle aria-hidden="true" />
          <AlertTitle>Documents are locked before the note is written</AlertTitle>
          <AlertDescription>
            <p>
              “{ENDPOINT_ACTION_LABELS['summary.finalize']}” locks EVERY document of the consultation, and “
              {ENDPOINT_ACTION_LABELS['harness.finalize']}” is what writes the note into it. In this order a consultation would close on an empty
              record. Move “{ENDPOINT_ACTION_LABELS['harness.finalize']}” above “{ENDPOINT_ACTION_LABELS['summary.finalize']}” — saving this order is
              refused.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {sequence.length === 0 ? (
        <Empty>
          <EmptyMedia variant="icon">
            <IconListNumbers aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No endpoint steps</EmptyTitle>
          <EmptyDescription>
            Consultations will close without finalizing or locking any document. Add at least the note-generation and document-locking steps.
          </EmptyDescription>
        </Empty>
      ) : (
        <ol className="flex flex-col gap-2" aria-label="Consultation endpoint sequence">
          {sequence.map((action, index) => (
            // `data-action` is the stable hook the tests read the ORDER off. Reading the visible
            // text instead would tie the ordering assertions to the label copy, and reading the
            // ordinal would make a reorder test pass trivially — the numbers are always 1..n.
            <li key={action} data-action={action} className="border-border flex items-start gap-3 rounded-md border p-3">
              <span className="text-muted-foreground w-6 shrink-0 pt-0.5 text-right font-mono text-sm">{index + 1}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="font-medium">{ENDPOINT_ACTION_LABELS[action]}</span>
                <span className="text-muted-foreground font-mono text-xs">{action}</span>
                <span className="text-muted-foreground text-sm">{ENDPOINT_ACTION_HINTS[action]}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${ENDPOINT_ACTION_LABELS[action]} earlier`}
                  disabled={index === 0}
                  onClick={() => setSequence((current) => move(current, index, -1))}
                >
                  <IconArrowUp aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${ENDPOINT_ACTION_LABELS[action]} later`}
                  disabled={index === sequence.length - 1}
                  onClick={() => setSequence((current) => move(current, index, 1))}
                >
                  <IconArrowDown aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${ENDPOINT_ACTION_LABELS[action]}`}
                  onClick={() => setSequence((current) => current.filter((entry) => entry !== action))}
                >
                  <IconTrash aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {available.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-56 flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="endpoint-sequence-add">
              Add a step
            </label>
            <Select value={toAdd} onValueChange={setToAdd}>
              <SelectTrigger id="endpoint-sequence-add">
                <SelectValue placeholder="Select a step to append…" />
              </SelectTrigger>
              <SelectContent>
                {available.map((key) => (
                  <SelectItem key={key} value={key}>
                    {ENDPOINT_ACTION_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={!toAdd}
            onClick={() => {
              if (!toAdd) return;
              setSequence((current) => [...current, toAdd as EndpointActionKey]);
              setToAdd('');
            }}
          >
            <IconPlus aria-hidden="true" />
            Append
          </Button>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="button" onClick={onSave} disabled={!dirty || save.isPending}>
          {save.isPending ? <Spinner aria-hidden="true" /> : null}
          Save sequence
        </Button>
        <Button type="button" variant="ghost" disabled={!dirty || save.isPending} onClick={() => setSequence(stored)}>
          Discard changes
        </Button>
        {!dirty ? <span className="text-muted-foreground text-sm">No unsaved changes</span> : null}
      </div>
    </div>
  );
}
