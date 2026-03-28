/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntity, CustomMapper } from '../../common';

export function AutoEntityChangeMapper<T extends BaseEntity, U extends object>(
  source: T,
  Target: new (...args: any[]) => U,
  customMappings?: Partial<Record<keyof U, CustomMapper<T, any>>>,
): Partial<U> {
  const changes = (source as any).changes;
  const model: Partial<U> = {};

  // Map properties from source to target *only* if they exist in the target
  const instance = new Target({});
  const instanceKeys = Object.keys(instance);
  for (const key in changes) {
    if (instanceKeys.includes(key)) {
      model[key as keyof U] = changes[key];
    }
  }

  /** Map properties from source to target using custom mappings,
   * this will overwrite the previous step if there is a custom mapping
   * for the same property, checks using change key / custom mapping key (mappingFunction)
   */
  if (customMappings) {
    Object.keys(customMappings).forEach((key: string) => {
      const mappingFunction = customMappings[key as keyof U];
      const sourceKey = Object.keys(changes).find((changeKey) => key === changeKey || mappingFunction);

      if (sourceKey) {
        const result = mappingFunction ? mappingFunction(changes) : changes[sourceKey];
        if (result) model[key as keyof U] = result;
      }
    });
  }

  return model;
}
