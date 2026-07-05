import type { Metadata } from 'next';
import { RateLimitsScreen } from '@/features/rate-limits/components/rate-limits-screen';

export const metadata: Metadata = {
    title: 'Rate Limits',
};

/** Frame 16 — Rate Limits (tier 10-19, GLOBAL_ADMIN only). */
export default function RateLimitsPage() {
    return <RateLimitsScreen />;
}
