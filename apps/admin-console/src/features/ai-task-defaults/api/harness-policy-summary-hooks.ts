'use client';

import { useQuery } from '@tanstack/react-query';
import { getHarnessPolicySummary } from './harness-policy-summary-client';
import { harnessPolicySummaryKeys } from './harness-policy-summary-keys';

export function useHarnessPolicySummary() {
    return useQuery({ queryKey: harnessPolicySummaryKeys.root, queryFn: getHarnessPolicySummary });
}
