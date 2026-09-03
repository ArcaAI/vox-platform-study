import type { Metadata } from 'next';

import { SdkScreen } from '@/features/developer-docs/components/sdk-screen';

export const metadata: Metadata = {
  title: 'SDKs',
};

/** The two published SDKs and which plane each can reach. */
export default function SdkPage() {
  return <SdkScreen />;
}
