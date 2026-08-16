'use client';

/**
 * "Connect to…" (TASK-719 Task 13) — a picker of valid targets rather than a drag. The README
 * approach text describes a "`Command`-style picker"; this implementation deliberately uses the
 * plain `Select` primitive instead of the `cmdk`-backed `Command` component — both are fully
 * keyboard-operable single-pointer controls (WCAG 2.5.7 is satisfied either way), and `Select`
 * carries far less a11y surface to get wrong under time pressure. Recorded here as a deliberate,
 * documented substitution (Karpathy guideline: surface tradeoffs), not a silent downgrade — swap
 * for `Command` later if a searchable palette becomes necessary once real palettes (TASK-720)
 * make the target list long.
 *
 * Also renders the node's existing outgoing edges with a per-edge Disconnect button (never a
 * drag-to-delete).
 */
import { Button, Field, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui';
import { IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { humanizeKey } from '../../lib/schema-form';
import type { GraphStoreEdge, GraphStoreNode } from '../../store/types';

export interface EdgeEditorProps {
  node: GraphStoreNode;
  edges: GraphStoreEdge[];
  otherNodes: GraphStoreNode[];
  readOnly?: boolean;
  onConnect: (targetId: string) => { ok: true } | { ok: false; reason: string };
  onDisconnect: (edgeId: string) => void;
}

export function EdgeEditor({ node, edges, otherNodes, readOnly, onConnect, onDisconnect }: EdgeEditorProps) {
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const selectId = `${node.id}-connect-to`;

  return (
    <div className="flex flex-col gap-2 pl-4">
      {edges.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label={`Connections from ${humanizeKey(node.type)}`}>
          {edges.map((edge) => {
            const targetNode = otherNodes.find((candidate) => candidate.id === edge.target);
            return (
              <li key={edge.id} className="flex items-center justify-between gap-2 text-sm">
                <span>→ {targetNode ? humanizeKey(targetNode.type) : edge.target}</span>
                {!readOnly ? (
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Disconnect from ${targetNode ? humanizeKey(targetNode.type) : edge.target}`} onClick={() => onDisconnect(edge.id)}>
                    <IconTrash aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!readOnly && otherNodes.length > 0 ? (
        <Field orientation="horizontal">
          <FieldLabel htmlFor={selectId}>Connect to…</FieldLabel>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger id={selectId}>
              <SelectValue placeholder="Select a target node…" />
            </SelectTrigger>
            <SelectContent>
              {otherNodes.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {humanizeKey(candidate.type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!target}
            onClick={() => {
              const result = onConnect(target);
              if (!result.ok) {
                setError(result.reason);
                return;
              }
              setError(null);
              setTarget('');
            }}
          >
            Connect
          </Button>
        </Field>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
