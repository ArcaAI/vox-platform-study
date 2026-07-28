import { getJson } from '@/shared/api';
import type { PstudioStatus } from './types';

export function getPstudioStatus(): Promise<PstudioStatus> {
  return getJson('admin/pstudio/status');
}
