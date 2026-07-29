import type { Metadata } from 'next';
import { ApiKeysScreen } from '@/features/api-keys/components/api-keys-screen';

export const metadata: Metadata = {
  title: 'API keys',
};

/** Frame 23 — API keys (tier 20-29 shared; scoped by the working tenant via the BFF). */
export default function ApiKeysPage() {
  return <ApiKeysScreen />;
}
