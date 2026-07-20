'use client';

import { useQuery } from '@tanstack/react-query';
import { getConsultationReview } from './client';
import { consultationReviewKeys } from './keys';

export function useConsultationReview(consultationId: string, enabled: boolean) {
    return useQuery({
        queryKey: consultationReviewKeys.detail(consultationId),
        queryFn: () => getConsultationReview(consultationId),
        enabled: enabled && !!consultationId,
    });
}
