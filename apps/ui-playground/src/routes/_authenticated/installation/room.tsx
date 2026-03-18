import RoomInstallation from '@/features/installation/pages/room';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/installation/room')({
    component: RoomInstallation,
});
