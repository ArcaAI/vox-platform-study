/**
 * @arcaai/ui shared component contracts.
 *
 * The reusable cross-component "interfaces": pagination, query-state,
 * async-collection, and surface (density/base/async-state) props consumed by
 * VirtualizedDataGrid, HistoryTimelineList, and LiveTranscript.
 */
export {
  type OffsetPageRequest,
  type CursorPageRequest,
  type PageRequest,
  type PageResult,
  type SdkPaginated,
  type ServerPaginated,
  fromSdkPaginated,
  fromServerPaginated,
} from './pagination';

export {
  type SortRule,
  type FilterRule,
  type DataQueryState,
  DEFAULT_QUERY_STATE,
  toPaginatedQuery,
  filterRuleToTokens,
  FILTER_OPERATOR_TOKENS,
} from './query-state';

export { type AsyncCollection } from './async-collection';

export { type Density, type DensityProps, type AsyncStateProps, type BaseSurfaceProps, DENSITY_ROW_HEIGHT, DENSITY_PADDING_Y } from './surface';

export { useExpansion, type UseExpansionParams, type UseExpansionResult, type ExpansionMode } from './use-expansion';
