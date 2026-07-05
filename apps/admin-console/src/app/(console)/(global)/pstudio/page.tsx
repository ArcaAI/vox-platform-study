import type { Metadata } from 'next';
import { PstudioScreen } from '@/features/pstudio/components/pstudio-screen';

export const metadata: Metadata = {
    title: 'Prisma Studio',
};

export default function PstudioPage() {
    return <PstudioScreen />;
}
