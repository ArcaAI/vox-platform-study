import type { Metadata } from 'next';
import { ConsultationActivityScreen } from '@/features/consultations/components/activity/consultation-activity-screen';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';

export const metadata: Metadata = { title: 'Consultation' };

/**
 * One consultation's activity timeline (tier 30-49). Unlike the list at `/consultations`, this
 * reads rows of one tenant's consultation, so an elevated session must pick a working tenant first.
 */
export default async function ConsultationActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <WorkingTenantGate title="Consultation" meta={<span className="font-mono text-xs break-all">{id}</span>}>
      <ConsultationActivityScreen consultationId={id} />
    </WorkingTenantGate>
  );
}
