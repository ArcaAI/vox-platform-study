/* eslint-disable @typescript-eslint/no-explicit-any */
import { CustomMapperHandlers, customInstanceToPlain } from '../../common';

export function AutoMapper<T extends object, U extends object>(source: T, customMappings: CustomMapperHandlers<T, U> = {}, removePrefix = true): U {
  const plainObject = customInstanceToPlain(source) as Record<string, any>;
  const targetProps: Partial<U> = {};
  for (const key in plainObject) {
    const targetKey = removePrefix && key.startsWith('_') ? (key.substring(1) as keyof U) : (key as keyof U);

    if (customMappings[targetKey]) {
      targetProps[targetKey] = customMappings[targetKey]?.(source) as U[keyof U];
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
  return targetProps as U;
}
