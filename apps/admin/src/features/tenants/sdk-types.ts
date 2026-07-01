import type { UseDepartmentsReturn } from '@arcaai/vox';

/**
 * The SDK `Department` shape. `@arcaai/vox` exports the hook + its return type but
 * NOT the bare `Department` interface, so we derive it from the hook's `departments`
 * array element (avoids touching the SDK package, TASK-379 constraint).
 */
export type Department = UseDepartmentsReturn['departments'][number];
