'use client';

import { useQuery } from '@tanstack/react-query';
import { getPstudioStatus } from './client';
import { dbStudioKeys } from './keys';

export function useDbStudioStatus() {
    return useQuery({ queryKey: dbStudioKeys.status(), queryFn: getPstudioStatus });
}
