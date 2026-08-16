'use client';

import { useState } from 'react';
import { Button } from '@arcaai/ui/components/shadcn/button';

/** ~200-char card truncation convention (rule 11 §8), "show more" to expand. */
const PREVIEW_LENGTH = 200;

export function KnowledgeChunkText({ text }: { text: string | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!text) {
    return <span className="text-muted-foreground text-sm italic">No decrypted text available (Vault-mode secrets are not wired in this environment).</span>;
  }

  const isLong = text.length > PREVIEW_LENGTH;
  const shown = expanded || !isLong ? text : `${text.slice(0, PREVIEW_LENGTH)}…`;

  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm whitespace-pre-wrap">{shown}</p>
      {isLong ? (
        <Button variant="link" size="sm" className="h-auto self-start p-0" onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      ) : null}
    </div>
  );
}
