'use client';

import { ProviderCredentialsTabs } from '@/features/ai-providers/components/provider-credentials-tabs';

/**
 * CONNECTIONS — the one authoritative bring-your-own credential editor, over
 * `admin/providers/:service/:provider`.
 *
 * A note on the import, because rule 13 says features never import each other:
 * this is the SAME cross-feature import `tenant-ai-configuration-screen.tsx`
 * already made, MOVED rather than multiplied. `/ai-configuration` drops its
 * Providers tab in the same change, so the count of cross-feature edges is
 * unchanged and the editor now sits with the configurations that consume it.
 * `features/ai-providers` remains the owner of the editor; this file only
 * places it.
 *
 * It belongs on the Providers tab because a connection and a configuration are
 * one job seen twice: the connection says WHERE a vendor is and how we
 * authenticate, the configuration says WHICH task it serves. Splitting them
 * across two screens is what made an operator onboarding a vendor navigate
 * twice, and it is what let the two drift.
 */
export function ProviderConnectionsSection() {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="provider-connections">
      <div>
        <h2 id="provider-connections" className="text-sm font-medium">
          Connections &amp; credentials
        </h2>
        <p className="text-muted-foreground text-xs">
          Where each vendor lives and how we authenticate to it. A tenant with no connection inherits the platform default; a tenant with its own key wins
          outright; a disabled connection is a veto in both tiers.
        </p>
      </div>
      <ProviderCredentialsTabs />
    </section>
  );
}
