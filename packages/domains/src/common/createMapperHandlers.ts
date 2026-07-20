export type CustomMapper<To, From> = (source: To) => From;

export type CustomMapperHandlers<
  To extends object,
  From extends object,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each key of `From` may map to a differently-shaped field, so the per-handler return type can't be pinned to one concrete type here without forcing every mapper across every entity to cast
> = Partial<Record<keyof From, CustomMapper<To, any>>>;

export interface MapperHandlers<To extends object, From extends object> {
  $toPersistence: CustomMapperHandlers<To, From>;
  $toDomain: CustomMapperHandlers<From, To>;
}

export function createMapperHandlers<To extends object, From extends object>(handlers: MapperHandlers<To, From>): MapperHandlers<To, From> {
  return handlers;
}

export type MapperNestedEntities<T> = {
  create?: T[];
  update?: T[];
};
