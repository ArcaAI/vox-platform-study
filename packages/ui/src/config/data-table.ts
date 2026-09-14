export type DataTableConfig = typeof dataTableConfig;

/**
 * NOTE on the operator lists below — they are the operators a user can PICK in
 * the filter controls, and every one of them must be serializable to a gateway
 * filter token by the console's `filterToTokens`
 * (`apps/admin-console/src/shared/data/grid-url-state.ts`).
 *
 * `notILike` ("Does not contain"), `isEmpty` and `isNotEmpty` were offered here
 * but have NO token in the v1 bracket grammar — the gateway's scalar operator
 * set has no negated-insensitive-contains and no null predicate. Picking one
 * updated the chip and the URL and then serialized to nothing, so the server
 * returned every row and the filter looked broken. They are removed rather than
 * faked. Do not re-add an operator here without a token for it.
 */
export const dataTableConfig = {
  textOperators: [
    { label: 'Contains', value: 'iLike' as const },
    { label: 'Is', value: 'eq' as const },
    { label: 'Is not', value: 'ne' as const },
  ],
  numericOperators: [
    { label: 'Is', value: 'eq' as const },
    { label: 'Is not', value: 'ne' as const },
    { label: 'Is less than', value: 'lt' as const },
    { label: 'Is less than or equal to', value: 'lte' as const },
    { label: 'Is greater than', value: 'gt' as const },
    { label: 'Is greater than or equal to', value: 'gte' as const },
    { label: 'Is between', value: 'isBetween' as const },
  ],
  dateOperators: [
    { label: 'Is', value: 'eq' as const },
    { label: 'Is not', value: 'ne' as const },
    { label: 'Is before', value: 'lt' as const },
    { label: 'Is after', value: 'gt' as const },
    { label: 'Is on or before', value: 'lte' as const },
    { label: 'Is on or after', value: 'gte' as const },
    { label: 'Is between', value: 'isBetween' as const },
    { label: 'Is relative to today', value: 'isRelativeToToday' as const },
  ],
  selectOperators: [
    { label: 'Is', value: 'eq' as const },
    { label: 'Is not', value: 'ne' as const },
  ],
  multiSelectOperators: [
    { label: 'Has any of', value: 'inArray' as const },
    { label: 'Has none of', value: 'notInArray' as const },
  ],
  booleanOperators: [
    { label: 'Is', value: 'eq' as const },
    { label: 'Is not', value: 'ne' as const },
  ],
  sortOrders: [
    { label: 'Asc', value: 'asc' as const },
    { label: 'Desc', value: 'desc' as const },
  ],
  filterVariants: ['text', 'number', 'range', 'date', 'dateRange', 'boolean', 'select', 'multiSelect'] as const,
  operators: [
    'iLike',
    'notILike',
    'eq',
    'ne',
    'inArray',
    'notInArray',
    'isEmpty',
    'isNotEmpty',
    'lt',
    'lte',
    'gt',
    'gte',
    'isBetween',
    'isRelativeToToday',
  ] as const,
  joinOperators: ['and', 'or'] as const,
};
