// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DefaultDbFieldType = Record<string, any>;

export type DbFilters<T = DefaultDbFieldType> = {
  [P in keyof T]?:
    | T[P]
    | {
        equals?: T[P];
        not?: T[P];
        in?: T[P][];
        notIn?: T[P][];
        lt?: T[P];
        lte?: T[P];
        gt?: T[P];
        gte?: T[P];
        contains?: string;
        startsWith?: string;
        endsWith?: string;
      };
} & {
  AND?: DbFilters<T>[];
  OR?: DbFilters<T>[];
};
