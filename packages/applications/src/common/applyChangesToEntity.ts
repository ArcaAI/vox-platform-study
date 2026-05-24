import { BaseEntity, ResourceStatusType } from '@arcaai/domains';

export type CustomChangeFieldHandlerProps<T, K> = {
  entity: T;
  changes: K;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
};
export type CustomChangeFieldHandler<T, K> = (props: CustomChangeFieldHandlerProps<T, K>) => void;

export type ChangeFieldHandlers<T, K> = {
  [P in keyof T | '$apply']?: CustomChangeFieldHandler<T, K>;
};

/**
 * Applies changes to the given entity based on the provided changes object.
 * If custom field handlers are provided, they will be invoked to process the change.
 *
 * Special behavior is applied for the `$apply` key in the customHandlers, where the handler
 * will be executed but its result will not be assigned back to the entity.
 *
 * @param entity - The entity to which changes will be applied.
 * @param changes - The changes object containing key-value pairs to update the entity.
 * @param customHandlers - An optional object containing custom handlers for specific fields.
 *
 * @example
 * // Example 1: Simple field assignment
 * const entity = { name: 'Old Name', age: 30 };
 * const changes = { name: 'New Name' };
 * await applyChangesToEntity(entity, changes);
 * // entity is now { name: 'New Name', age: 30 }
 *
 * @example
 * // Example 2: Using custom handlers
 * const entity = { name: 'Old Name', age: 30 };
 * const changes = { name: 'New Name', age: 31 };
 * const handlers = {
 *   name: ({ entity, value }) => value.toUpperCase(), // Custom handler to uppercase name
 *   age: ({ entity, value }) => value + 1,            // Custom handler to increase age by 1
 * };
 * await applyChangesToEntity(entity, changes, handlers);
 * // entity is now { name: 'NEW NAME', age: 32 }
 *
 * @example
 * // Example 3: Using the $apply handler
 * const entity = { name: 'Old Name', age: 30 };
 * const changes = { name: 'New Name', age: 31 };
 * const handlers = {
 *   $apply: ({ entity, changes }) => {
 *     // This handler processes all changes globally but does not assign any value back
 *     console.log('Applying changes globally:', changes);
 *   },
 *   name: ({ entity, value }) => value.toLowerCase(), // Custom handler to lowercase name
 * };
 * await applyChangesToEntity(entity, changes, handlers);
 * // entity is now { name: 'new name', age: 31 }
 * // The $apply handler ran, but didn't modify the entity.
 */
export async function applyChangesToEntity<T extends BaseEntity, K extends object>(
  entity: T,
  changes: K,
  customHandlers?: ChangeFieldHandlers<T, K>,
): Promise<void> {
  for (const key of Object.keys(changes) as Array<keyof K>) {
    // TASK-302 Stream D Phase B (B.7) — `version` is database-owned. The only
    // legitimate writer is `Repository.updateWithVersion`. Filtering here is
    // defense in depth on top of the entity having no public setter and the
    // mapper $toPersistence excluding it. The guard runs before custom
    // handler dispatch so a malicious DTO cannot smuggle `version` through a
    // handler either.
    if ((key as unknown as string) === 'version') {
      continue;
    }

    const value = changes[key];

    if (customHandlers && key in customHandlers) {
      const handler = customHandlers[key as keyof T | '$apply'];
      if (handler) {
        const result = await handler({
          entity,
          changes,
          value,
        });

        if (key !== '$apply' && result !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (entity as any)[key] = result;
        }
      }
    } else if (value !== undefined) {
      if (key === 'resourceStatus') {
        switch (value) {
          case ResourceStatusType.ENABLED:
            entity.enable();
            break;
          case ResourceStatusType.DISABLED:
            entity.disable();
            break;
          case ResourceStatusType.ARCHIVED:
            entity.archive();
            break;
          case ResourceStatusType.DELETED:
            entity.delete();
            break;
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (entity as any)[key] = value;
      }
    }
  }
}
