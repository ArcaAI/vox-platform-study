'use client';

import { useId } from 'react';
import { IconExternalLink, IconSettings } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { can, canAny, usePermissions } from '@/shared/auth';

/**
 * TASK-956 — where this tenant's settings are edited.
 *
 * The Tenant profile used to carry a Settings TAB: a third editor over the very
 * `GlobalSetting` rows that `/settings` (rows & secrets — the row editor with
 * the code editor, audited secret reveal/rotate, OCC and history) and
 * `/settings-registry` (the descriptor-governed keys with the tenant → platform
 * cascade) already own. It bucketed rows by a client-side keyword heuristic,
 * edited JSON and secrets in plain text controls, ran its own OCC client, and
 * disagreed with `/settings` about which rows a tenant admin sees at all.
 *
 * One authoritative editor per backend resource (rule 13). Precedent:
 * `/harness/policy` demoted to a summary + deep link when `/agentic-policy`
 * became the owner. There is nothing to summarise here that would not drift
 * from the owners' own counts, so this is the deep link alone.
 *
 * Plain hrefs, not cross-feature imports (features stay isolated), and gated on
 * the caller's abilities the same way the nav is: the rows screen needs
 * `manage:GlobalSetting`, the registry `read` or `manage`. A caller with neither
 * (a clinician, an impersonated end-user) sees nothing rather than two 404s.
 */
export function TenantSettingsPointer() {
  const uid = useId();
  const { data: rules } = usePermissions();
  const canManage = can(rules, 'manage', 'GlobalSetting');
  const canRead = canAny(rules, [
    ['read', 'GlobalSetting'],
    ['manage', 'GlobalSetting'],
  ]);

  if (!canRead) return null;

  return (
    <section aria-labelledby={`${uid}-settings`} className="flex flex-col gap-3">
      <Card className="gap-3 p-4">
        <div className="flex items-start gap-3">
          <IconSettings aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={`${uid}-settings`} className="text-sm font-medium">
              Settings
            </h2>
            <p className="text-muted-foreground text-sm">
              This tenant&apos;s settings are managed on their own screens: the governed keys with the platform fallback in the
              registry, and the stored rows and secrets in the rows editor.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:pl-7">
          <Button variant="outline" size="sm" asChild>
            <a href="/settings-registry">
              <IconExternalLink aria-hidden />
              Settings registry
            </a>
          </Button>
          {canManage ? (
            <Button variant="outline" size="sm" asChild>
              <a href="/settings">
                <IconExternalLink aria-hidden />
                Settings rows &amp; secrets
              </a>
            </Button>
          ) : null}
        </div>
      </Card>
    </section>
  );
}
