import ClinicalWorkspacePage from '@/features/clinical-workspace/clinical-workspace-page';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/clinical-workspace/')({
  component: ClinicalWorkspacePage,
});
