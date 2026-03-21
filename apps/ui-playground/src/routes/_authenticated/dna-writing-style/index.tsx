import DnaWritingStylePage from '@/features/dna-writing-style';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/dna-writing-style/')({
    component: DnaWritingStylePage,
});
