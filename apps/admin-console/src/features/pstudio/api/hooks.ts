'use client';

import { useQuery } from '@tanstack/react-query';
import { getPstudioStatus } from './client';
import { pstudioKeys } from './keys';

export function usePstudioStatus() {
    return useQuery({ queryKey: pstudioKeys.status(), queryFn: getPstudioStatus });
}
