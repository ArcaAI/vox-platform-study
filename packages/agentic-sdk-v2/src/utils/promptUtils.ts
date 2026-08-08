/**
 * @arcaai/vox - Prompt Template Utilities
 *
 * Utility functions for working with prompt templates,
 * including variable substitution and validation.
 */

import type { PromptVariable } from '../types/prompt';

/**
 * Regex matching `{variable_name}` placeholders in prompt templates.
 * Supports alphanumeric names with underscores and hyphens.
 */
const VARIABLE_PATTERN = /\{([a-zA-Z_][\w-]*)\}/g;

/**
 * Substitute variables in a prompt template string.
 *
 * Replaces `{variable_name}` placeholders with values from the provided map.
 * Unmatched placeholders are left as-is unless `strict` is true.
 *
 * @param template - The prompt template string containing `{variable}` placeholders
 * @param variables - Map of variable names to their replacement values
 * @param options.strict - If true, throws when a placeholder has no matching value
 * @returns The template with variables substituted
 *
 * @example
 * ```ts
 * const result = substitutePromptVariables(
 *   'Hello {patient_name}, your appointment is on {date}.',
 *   { patient_name: 'John', date: '2026-03-01' }
 * );
 * // => 'Hello John, your appointment is on 2026-03-01.'
 * ```
 */
export function substitutePromptVariables(template: string, variables: Record<string, string>, options?: { strict?: boolean }): string {
  return template.replace(VARIABLE_PATTERN, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, name)) {
      return variables[name];
    }
    if (options?.strict) {
      throw new Error(`Missing value for prompt variable: {${name}}`);
    }
    return match;
  });
}

/**
 * Extract all variable names from a prompt template string.
 *
 * @returns Array of unique variable names found in the template
 */
export function extractPromptVariables(template: string): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(VARIABLE_PATTERN.source, 'g');
  while ((m = re.exec(template)) !== null) {
    names.add(m[1]);
  }
  return Array.from(names);
}

/**
 * Validate that all required variables have values provided.
 *
 * @returns Array of variable names that are required but missing from `values`
 */
export function validatePromptVariables(variableDefinitions: PromptVariable[], values: Record<string, string>): string[] {
  return variableDefinitions.filter((v) => v.required && !Object.prototype.hasOwnProperty.call(values, v.name)).map((v) => v.name);
}
