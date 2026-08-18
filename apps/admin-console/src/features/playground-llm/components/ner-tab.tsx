'use client';

import { useState } from 'react';
import { IconTags } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { useExtractEntities } from '../api/hooks';
import type { NerResult } from '../api/types';

/**
 * Agent Playground → NER tab. Input → medical entity list via the
 * `text-analyses/entities` gateway proxy (NLP token classification). Runs under the
 * caller's own account (user-plane `@Authorize()`).
 */
export function NerTab() {
  const [text, setText] = useState('');
  const extract = useExtractEntities();
  const canRun = text.trim().length > 0 && !extract.isPending;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Extract entities</CardTitle>
          <CardDescription>Runs medical named-entity recognition (token classification) over the text.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ner-text">Text</Label>
            <Textarea
              id="ner-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste clinical text to extract entities from…"
              className="min-h-40 resize-none"
            />
          </div>
          <Button className="self-start" disabled={!canRun} onClick={() => extract.mutate({ text })}>
            {extract.isPending ? <Spinner /> : <IconTags aria-hidden />}
            Extract
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Entities</CardTitle>
        </CardHeader>
        <CardContent>
          {extract.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-5/6" />
              <Skeleton className="h-6 w-2/3" />
            </div>
          ) : extract.isError ? (
            <p className="text-destructive text-sm">{(extract.error as Error).message}</p>
          ) : extract.data ? (
            <NerEntities data={extract.data} />
          ) : (
            <p className="text-muted-foreground text-sm">Run an extraction to see the detected entities.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function NerEntities({ data }: { data: NerResult }) {
  if (data.entities.length === 0) {
    return <p className="text-muted-foreground text-sm">No entities found.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Detected entities" className="flex flex-col gap-2">
        {data.entities.map((entity, index) => (
          <li
            key={entity.id ?? `${entity.entity_type}-${entity.text}-${index}`}
            className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
          >
            <Badge variant="secondary">{entity.entity_type}</Badge>
            <span className="text-sm font-medium">{entity.text}</span>
            <span className="text-muted-foreground ml-auto text-xs tabular-nums">{Math.round((entity.confidence ?? 0) * 100)}%</span>
          </li>
        ))}
      </ul>
      {data.model_version ? <p className="text-muted-foreground font-mono text-xs">model {data.model_version}</p> : null}
    </div>
  );
}
