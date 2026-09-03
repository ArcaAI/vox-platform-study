import type { Metadata } from 'next';
import { WorkbenchScreen } from '@/features/workbench/components';

export const metadata: Metadata = { title: 'Workbench' };

/** Tier 50-59 Playground — sandboxed interpreter runs against synthetic inputs. */
export default function WorkbenchPage() {
  return <WorkbenchScreen />;
}
