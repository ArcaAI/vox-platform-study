import type { Metadata } from 'next';
import { DocumentTemplatesScreen } from '@/features/document-templates/components/document-templates-screen';

export const metadata: Metadata = { title: 'Document Templates' };

/** Document Templates — the tenant's clinical document shape catalog (tier 30-49). */
export default function DocumentTemplatesPage() {
  return <DocumentTemplatesScreen />;
}
