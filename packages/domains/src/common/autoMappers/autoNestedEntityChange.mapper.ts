import { BaseEntity } from '../../common';
import { generateId } from '../../utils';

interface MapperNestedModels<U> {
  create?: U[];
  update?: { data: U; where: { id: string } }[] | U;
  connect?: { id: string };
}

interface AutoNestedEntityChangeOptions<T extends BaseEntity> {
  mapper: (obj: T) => any;
  shouldConnect?: boolean;
  deletedKeys?: (keyof T)[];
}

/**
 * AutoNestedEntityChange is a utility function designed to handle nested entity changes
 * for updating data models in a Prisma-like ORM. It processes both single objects and arrays of objects,
 * automatically determining whether to create, update, or connect nested entities based on the presence
 * or absence of an `id` property.
 *
 * @template T - The type of the entity being processed. It extends `BaseEntity`, ensuring that
 *               the entity has at least an `id` property.
 * @template U - The type of the mapped entity used for persistence operations.
 *
 * @param {T | T[]} obj - The entity or array of entities to be processed. If an array is provided, each entity
 *                        in the array is processed individually.
 * @param {AutoNestedEntityChangeOptions<T>} options - Configuration options for how the entity should be processed.
 * @param {(obj: T) => U} options.mapper - A mapping function that converts the input entity `T`
 *                                           to the output format `U` required for persistence.
 * @param {boolean} [options.shouldConnect=false] - If true, the function will generate a `connect` operation
 *                                                     for a single entity based on its `id`. This is typically used
 *                                                     for associating existing entities.
 * @param {(keyof U)[]} [options.deletedKeys=[]] - An optional array of keys to be deleted from the mapped entity
 *                                                   before creating or updating it. This is useful for excluding certain
 *                                                   fields from the persistence operation.
 *
 * @returns {MapperNestedModels<U>} - Returns an object containing `create`, `update`, or `connect` operations.
 *   - `create`: An array of new entities to be created.
 *   - `update`: An array of existing entities to be updated, along with their `where` conditions.
 *   - `connect`: A `connect` operation if `shouldConnect` is true and the entity is being connected by `id`.
 *
 * @example
 * const teams = [
 *     new TeamEntity({ id: '1', name: 'Team A' }),
 *     new TeamEntity({ name: 'Team B' }) // New team without an ID
 * ];
 *
 * const changes = AutoNestedEntityChange(teams, {
 *     mapper: (team) => ({
 *         teamId: team.id,
 *         teamName: team.name,
 *     }),
 *     deletedKeys: ['teamId'], // Exclude the `teamId` from new creates
 * });
 *
 * // Result:
 * // {
 * //     create: [{ teamName: 'Team B', id: 'generated-id-123' }],
 * //     update: [{ data: { teamName: 'Team A' }, where: { id: '1' } }]
 * // }
 */

export function AutoNestedEntityChange<T extends BaseEntity, U extends object>(
  obj: T | T[],
  options: AutoNestedEntityChangeOptions<T>,
): MapperNestedModels<U> {
  const { mapper, shouldConnect = false, deletedKeys = [] } = options;
  const model: MapperNestedModels<U> = {};

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const mappedItem = mapper({ changes: item } as any) as U;

      // Remove specified keys from the mapped item
      if (deletedKeys) {
        deletedKeys.forEach((key) => delete (mappedItem as any)[key]);
      }

      if (!item.id) {
        model.create = model.create || [];
        model.create.push({
          ...mappedItem,
          id: generateId(),
        });
      } else {
        model.update = model.update || [];
        (model.update as { data: U; where: { id: string } }[]).push({
          data: mappedItem,
          where: { id: item.id },
        });
      }
    }
  } else {
    if (shouldConnect) {
      return { connect: { id: obj.id } };
    } else {
      model.update = mapper(obj) as U;
    }
  }

  return model;
}
