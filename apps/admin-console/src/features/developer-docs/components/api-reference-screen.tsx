'use client';

import { useState } from 'react';
import { IconBook2 } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';

import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import type { SpecPlane } from '../types';
import { ApiReference } from './api-reference';

/**
 * The reference screen. `contentMode="fill"` hands the remaining height to
 * Scalar, which brings its own sidebar and scroll — nesting it inside the
 * template's own scroll container would produce two scrollbars (rule 11
 * §Screen Template: one scroll container per panel).
 */
export function ApiReferenceScreen({ canReadAdminPlane }: { canReadAdminPlane: boolean }) {
  const [plane, setPlane] = useState<SpecPlane>('business');

  // Without the admin ability there is nothing to switch between, so the tab
  // strip would be a control with one option — noise, not a choice.
  if (!canReadAdminPlane) {
    return (
      <ScreenTemplate
        header={<PageHeader title="API reference" meta={<span>The tenant-facing HOPE API — every route a tenant credential can reach.</span>} />}
        contentMode="fill"
        footer={<StatusFooter start="Read-only reference" end={<span>Business plane</span>} />}
      >
        <ApiReference plane="business" />
      </ScreenTemplate>
    );
  }

  return (
    <Tabs value={plane} onValueChange={(value) => setPlane(value as SpecPlane)} className="flex min-h-0 flex-1 flex-col">
      <ScreenTemplate
        header={
          <PageHeader
            title="API reference"
            meta={
              <span className="flex items-center gap-2">
                <IconBook2 aria-hidden className="size-4" />
                Generated from the gateway&apos;s OpenAPI document and its route authorization metadata.
              </span>
            }
          />
        }
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="business">Business plane</TabsTrigger>
            <TabsTrigger value="admin">
              Administration plane
              <Badge variant="secondary">super admin</Badge>
            </TabsTrigger>
          </TabsList>
        }
        contentMode="fill"
        footer={
          <StatusFooter
            start="Read-only reference"
            end={<span>{plane === 'business' ? 'API-key reachable routes only' : 'Every documented route, including /admin'}</span>}
          />
        }
      >
        {/* Both panels stay mounted so switching planes does not re-download
            and re-parse a 1.4 MB document every time. */}
        <TabsContent value="business" className="min-h-0 flex-1 data-[state=inactive]:hidden">
          <ApiReference plane="business" />
        </TabsContent>
        <TabsContent value="admin" className="min-h-0 flex-1 data-[state=inactive]:hidden">
          <ApiReference plane="admin" />
        </TabsContent>
      </ScreenTemplate>
    </Tabs>
  );
}
