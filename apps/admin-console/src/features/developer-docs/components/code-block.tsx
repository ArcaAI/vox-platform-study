'use client';

import { useState } from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';

/**
 * A copyable snippet. Every example in the portal is meant to be pasted, so a
 * copy button is part of the content rather than a nicety — and the visible
 * confirmation is the 100 ms feedback rule 11 §5 asks for.
 */
export function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  };

  return (
    <div className="group/code relative">
      <pre className="bg-muted text-foreground overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        className="absolute top-2 right-2"
        onClick={() => void copy()}
      >
        {copied ? <IconCheck aria-hidden className="size-4" /> : <IconCopy aria-hidden className="size-4" />}
      </Button>
    </div>
  );
}
