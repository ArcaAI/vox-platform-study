/**
 * TASK-404 — `/components` design-system reference (P2-2, `01 · Components`).
 *
 * Super-admin/dev-tier showcase of the admin design system: tokens, type,
 * shape, status grammar, and the grouped `@arcaai/ui` primitives the console
 * composes. Foundations tier (00–09) per the TASK-371 taxonomy; guarded like
 * the other platform surfaces. Nav entry is owned by TASK-403 (`lib/nav.ts`).
 */

import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '@/components/layout/page-header';
import {
  MetricsSection,
  PrimitivesSection,
  SHOWCASE_SECTIONS,
  ShapeSection,
  StatusSection,
  TokensSection,
  TypographySection,
} from '@/features/components-library';
import { requireSuperAdmin } from '@/lib/route-guards';

export const Route = createFileRoute('/_authenticated/components')({
  staticData: { crumb: [{ label: 'Platform', to: null }, { label: 'Components' }] },
  beforeLoad: ({ context }) => requireSuperAdmin(context),
  component: ComponentsPage,
});

function ComponentsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Components" description="Design-system reference — tokens, typography, and the shared @arcaai/ui primitives." />

      <nav aria-label="Showcase sections" className="hidden flex-wrap gap-1.5 md:flex">
        {SHOWCASE_SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {section.title}
          </a>
        ))}
      </nav>

      <TokensSection />
      <TypographySection />
      <ShapeSection />
      <StatusSection />
      <PrimitivesSection />
      <MetricsSection />
    </div>
  );
}
