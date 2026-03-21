import PreSummaryPage from '@/features/summarization/pre-summary';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/summarization/pre-summary')({
    component: PreSummaryPage,
});
