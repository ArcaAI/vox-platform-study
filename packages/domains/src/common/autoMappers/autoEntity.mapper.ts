/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntity, CustomMapperHandlers } from '../../common';

/**
 * Maps the properties of an entity to a target object type.
 *
 * @param entity - The source entity to be mapped.
 * @param target - The target class to which properties are mapped.
 * @param customMappings - Optional custom mapping handlers for specific properties.
 * @returns An instance of the target class with mapped properties.
 */
export function AutoEntityMapper<T extends object, U extends object>(
    entity: T,
    target: new (...args: any[]) => U,
    customMappings?: CustomMapperHandlers<T, U>,
): U {
    // Convert the entity to a plain object
    const plainEntity = (entity as BaseEntity).toObject() as Record<
        string,
        any
    >;

    // Get the target model instance to access its properties
    const targetInstance = new target({});
    const virtualProperties =
        (targetInstance.constructor as any).__virtualProperties || [];

    // Create a partial object to store target properties
    const targetProps: Partial<U> = {};

    // Iterate over the properties of the plain entity
    for (const key in plainEntity) {
        if (Object.prototype.hasOwnProperty.call(plainEntity, key)) {
            const targetKey = key as keyof U;

            // Skip 'changes' and 'domainEvents' properties
            if (
                virtualProperties.includes(targetKey) ||
                targetKey === 'changes' ||
                targetKey === 'domainEvents'
            ) {
                delete targetProps[targetKey];
                continue;
            }

            // Include only properties that exist in the target model
            if (targetKey in targetInstance) {
                // If a custom mapping exists, use it; otherwise, use the plain entity value
                if (customMappings && customMappings[targetKey]) {
                    const mappedValue = customMappings[targetKey]?.(entity);
                    // Fallback to plain entity value if mapped value is null/undefined
                    targetProps[targetKey] = (mappedValue ?? plainEntity[key]) as U[keyof U];
                } else {
                    targetProps[targetKey] = plainEntity[key];
                }
            }
        }
    }

    // Apply custom mappers for fields that are not in the source object but exist in the target model
    if (customMappings) {
        for (const key in customMappings) {
            if (Object.prototype.hasOwnProperty.call(customMappings, key)) {
                const customMapperKey = key as keyof U;
                const sourceKey = customMapperKey as unknown as keyof T;

                // If the source key does not exist in the plain entity and the custom mapper key is valid
                if (
                    !Object.prototype.hasOwnProperty.call(
                        plainEntity,
                        sourceKey,
                    ) &&
                    customMapperKey in targetInstance
                ) {
                    targetProps[customMapperKey] = customMappings[
                        customMapperKey
                    ]?.(entity) as U[keyof U];
                }
            }
        }
    }

    // Return a new instance of the target class with the mapped properties
    return new target(targetProps);
}
