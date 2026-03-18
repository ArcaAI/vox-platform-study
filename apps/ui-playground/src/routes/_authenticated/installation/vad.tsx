import VadInstallation from '@/features/installation/pages/vad';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/installation/vad')({
    component: VadInstallation,
});
