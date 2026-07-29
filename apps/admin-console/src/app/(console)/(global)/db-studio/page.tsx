import type { Metadata } from 'next';
import { DbStudioScreen } from '@/features/db-studio/components/db-studio-screen';

export const metadata: Metadata = {
  title: 'Database Studio',
};

export default function DbStudioPage() {
  return <DbStudioScreen />;
}
