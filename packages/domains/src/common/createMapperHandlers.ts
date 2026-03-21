export type CustomMapper<To, From> = (source: To) => From;

export type CustomMapperHandlers<
    To extends object,
    From extends object,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
> = Partial<Record<keyof From, CustomMapper<To, any>>>;

export interface MapperHandlers<To extends object, From extends object> {
    $toPersistence: CustomMapperHandlers<To, From>;
    $toDomain: CustomMapperHandlers<From, To>;
}

export function createMapperHandlers<To extends object, From extends object>(
    handlers: MapperHandlers<To, From>,
): MapperHandlers<To, From> {
    return handlers;
}

export type MapperNestedEntities<T> = {
    create?: T[];
    update?: T[];
};
