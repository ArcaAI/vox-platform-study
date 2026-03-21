import NoiseFilterInstallation from '@/features/installation/pages/noise-filter';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/installation/noise-filter')({
    component: NoiseFilterInstallation,
});
