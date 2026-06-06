import ClinicalReviewPage from '@/features/clinical-review/review';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/clinical-review')({
  component: ClinicalReviewPage,
});
