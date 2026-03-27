import SummaryPage from '@/features/summarization/summary';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/summarization/summary')({
  component: SummaryPage,
});
