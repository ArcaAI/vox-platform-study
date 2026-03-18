import SttInstallation from '@/features/installation/pages/stt';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/installation/stt')({
    component: SttInstallation,
});
