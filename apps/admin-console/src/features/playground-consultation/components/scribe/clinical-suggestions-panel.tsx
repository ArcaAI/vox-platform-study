'use client';

/**
 * TASK-797 W2 — intelligent suggestions.
 *
 * The harness node's system prompt scopes these deliberately: "the most useful next
 * questions, checks or omissions to consider", grounded in the supplied text, "never state a
 * diagnosis as fact and never invent clinical findings", empty list when there is nothing
 * useful. This surface honours that framing rather than dressing the output up:
 *
 *  - they are labelled as prompts to CONSIDER, not findings;
 *  - they are marked AI (rule 11 §7);
 *  - the ONLY action is Dismiss. There is no affordance that writes a suggestion into the
 *    note, because a suggestion is a question to the clinician, not content for the record.
 *
 * An empty set renders nothing at all — "no suggestions" is the node's normal answer and does
 * not deserve a labelled empty box.
 */

import { useState } from 'react';
import { IconBulb, IconX } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import type { ClinicalSuggestionSet } from '../../api/pending-contracts';

export interface ClinicalSuggestionsPanelProps {
  suggestionSet: ClinicalSuggestionSet | null;
}

export function ClinicalSuggestionsPanel({ suggestionSet }: ClinicalSuggestionsPanelProps) {
  const [dismissed, setDismissed] = useState<readonly string[]>([]);

  const visible = (suggestionSet?.suggestions ?? []).filter((suggestion) => !dismissed.includes(suggestion.text));
  if (!suggestionSet || visible.length === 0) return null;

  const attribution = [suggestionSet.provider, suggestionSet.model].filter(Boolean).join(':');

  return (
    <section className="border-t pt-3" aria-label="Suggestions to consider">
      <div className="text-muted-foreground mb-1.5 flex flex-wrap items-center gap-1.5 text-xs font-medium">
        <IconBulb aria-hidden className="size-3.5" />
        Suggestions to consider
        <span className="bg-ai/10 text-ai rounded px-1 text-xs font-medium">AI</span>
        {attribution ? <span className="font-mono font-normal">{attribution}</span> : null}
      </div>
      <ul className="flex list-none flex-col gap-1.5">
        {visible.map((suggestion) => (
          <li key={suggestion.text} className="flex items-start justify-between gap-2 rounded-md border px-3 py-2">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-sm">{suggestion.text}</p>
              {suggestion.category ? (
                <span>
                  <Badge variant="outline">{suggestion.category}</Badge>
                </span>
              ) : null}
            </div>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="shrink-0"
              aria-label={`Dismiss suggestion: ${suggestion.text}`}
              onClick={() => setDismissed((current) => [...current, suggestion.text])}
            >
              <IconX aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground mt-1.5 text-xs">Prompts to consider — not clinical advice, and not part of the note.</p>
    </section>
  );
}
