import type { Metadata } from 'next';
import { ConsultationDemoScreen } from '@/features/playground-consultation/components/consultation-demo-screen';

export const metadata: Metadata = { title: 'Consultation Demo' };

/** Frames 50 + 50.1 — @arcaai/vox consultation demo (playground, matrix row 34). */
export default function ConsultationDemoPage() {
  return <ConsultationDemoScreen />;
}
