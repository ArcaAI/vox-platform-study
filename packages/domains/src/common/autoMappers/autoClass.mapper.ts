/* eslint-disable @typescript-eslint/no-explicit-any */
import { AutoEntityMapper, BaseEntity, CustomMapperHandlers } from '../../common';

export function AutoClassMapper<T extends object, U extends object>(
  source: T,
  target: new (...args: any[]) => U,
  customMappings: CustomMapperHandlers<T, U> = {},
  removePrefix = true,
): U {
  if (source instanceof BaseEntity) {
    return AutoEntityMapper(source, target, customMappings);
  }

  const plainObject = source as Record<string, any>;
  const targetProps: Partial<U> = {};
  for (const key in plainObject) {
    const targetKey = removePrefix && key.startsWith('_') ? (key.substring(1) as keyof U) : (key as keyof U);

    if (customMappings[targetKey]) {
      const mappedValue = customMappings[targetKey]?.(source);
      // Fallback to plain object value if mapped value is null/undefined
      targetProps[targetKey] = (mappedValue ?? plainObject[key]) as U[keyof U];
    } else {
      targetProps[targetKey] = plainObject[key] as unknown as U[keyof U];
    }
  }

  // Apply custom mappers for fields that are not in the source object
  for (const key in customMappings) {
    const customMapperKey = key as keyof U;
    const sourceKey =
      removePrefix && typeof customMapperKey === 'string' && customMapperKey.startsWith('_')
        ? (customMapperKey.substring(1) as keyof T)
        : (customMapperKey as unknown as keyof T);

    if (!Object.prototype.hasOwnProperty.call(plainObject, sourceKey) && customMapperKey) {
      targetProps[customMapperKey] = customMappings[customMapperKey]?.(source) as U[keyof U];
    }
  }
  return new target(targetProps);
}
