'use client';

/**
 * The slug and its copy control. The slug is the lineage's public key (`POST /workflows/{slug}/runs`),
 * so copying it is the header's most common gesture; the control confirms in text ("Copied", in a
 * polite live region) as well as a toast so the confirmation is announced and sits where the eye is.
 */
import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui';

const COPIED_MS = 2000;

export function SlugCopy({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(slug);
    } catch {
      toast.error('Copy failed');
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono text-xs">{slug}</span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Copy slug" title="Copy slug" onClick={() => void copy()}>
        {copied ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
      </Button>
      <span role="status" className="text-success-strong min-w-12 text-xs">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  );
}
