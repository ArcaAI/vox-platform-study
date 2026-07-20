// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fallback generic default for DbFilters<T>/IFindAllProps<T> across every repository; entity field shapes vary too widely (string/number/Date/enum/nested) for a narrower default, and `unknown` would block the comparison-operator shapes (`equals`/`lt`/etc.) DbFilters builds from `T[P]`
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
