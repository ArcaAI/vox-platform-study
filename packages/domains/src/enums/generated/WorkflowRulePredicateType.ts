/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

export enum WorkflowRulePredicateType {
  ACYCLIC = 'ACYCLIC',
  SINGLE_ENTRY = 'SINGLE_ENTRY',
  REACHABLE_FROM_ENTRY = 'REACHABLE_FROM_ENTRY',
  REACHES_TERMINAL = 'REACHES_TERMINAL',
  REQUIRED_NODE_TYPE = 'REQUIRED_NODE_TYPE',
  FORBIDDEN_NODE_TYPE = 'FORBIDDEN_NODE_TYPE',
  REQUIRED_PATH_THROUGH = 'REQUIRED_PATH_THROUGH',
  FORBIDDEN_PATH = 'FORBIDDEN_PATH',
  ORDERED_BEFORE = 'ORDERED_BEFORE',
  BOUND = 'BOUND',
  CONFIG_PREDICATE = 'CONFIG_PREDICATE',
}
