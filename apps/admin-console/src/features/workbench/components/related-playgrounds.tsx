import { IconArrowRight, IconBroadcast, IconSparkles } from '@tabler/icons-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';

const LINKS = [
  {
    href: '/playground/llm',
    label: 'LLM Playground',
    description: 'Free-form text generation, guardrails, and NER testing.',
    Icon: IconSparkles,
  },
  {
    href: '/playground/live-transcription',
    label: 'Live Transcription',
    description: 'STT streaming testing.',
    Icon: IconBroadcast,
  },
] as const;

/**
 * Cross-links to the existing STT / text-generation playgrounds (TASK-721 Task 10). Plain
 * `href`s only — no cross-feature imports, no re-implementation (README §2.3): those surfaces
 * already cover the free-form exploration case; this card just points at them.
 */
export function RelatedPlaygrounds() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Related playgrounds</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {LINKS.map(({ href, label, description, Icon }) => (
          <Link
            key={href}
            href={href}
            className="hover:bg-muted focus-visible:ring-ring flex items-center gap-3 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          >
            <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{label}</span>
              <span className="text-muted-foreground block text-xs">{description}</span>
            </span>
            <IconArrowRight aria-hidden className="text-muted-foreground size-4 shrink-0" />
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
