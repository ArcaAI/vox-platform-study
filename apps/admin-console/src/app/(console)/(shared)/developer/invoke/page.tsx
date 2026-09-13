import type { Metadata } from 'next';

import { InvokeGuideScreen } from '@/features/developer-docs/components/invoke-guide-screen';

export const metadata: Metadata = {
  title: 'Call an agent or workflow',
};

/**
 * The direct HTTP contract for a published agent or workflow — credentials,
 * the flat-vs-enveloped body shapes, the async/blocking/stream progression,
 * SSE framing, and the Postman import walkthrough. Gated by the shared
 * `developer/layout.tsx` above this route, same as every other developer
 * portal screen.
 */
export default function InvokeGuidePage() {
  return <InvokeGuideScreen />;
}
