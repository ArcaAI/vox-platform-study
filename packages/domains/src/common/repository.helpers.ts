import { DbFilters, DefaultDbFieldType, ICountProps, IFindAllProps } from '../interfaces';

export function formatFindAllProps<T = DefaultDbFieldType>({ page, limit, filters, search, searchFields, sort, where }: IFindAllProps<T>) {
  let skip = 0;
  if (page != null && limit) {
    skip = Math.max(0, (page - 1) * limit);
  }

  // Merge `filters` and `where` into ONE predicate.
  //
  // The branch structure below is the original one, and the shape it produces
  // (the AND-less side pushed INTO the other side's `AND`) is unchanged and
  // still asserted by this file's tests. What changed is that each branch used
  // to keep ONLY the `AND` array and silently DISCARD every sibling scalar key
  // on the same object. A caller passing
  // `where: { tenantId, externalPatientId, AND: [...] }` therefore lost its
  // `tenantId` and read ACROSS TENANTS — while `formatCountProps` (which wraps
  // instead of branching) counted the correct rows, so the bug surfaced as a
  // page whose contents disagreed with its own count rather than as an obvious
  // leak. No caller passed a where-with-AND until consent register,
  // which is why it went unnoticed. Sibling keys are now carried through at the
  // top level, where Prisma ANDs them with the array anyway.
  //
  // The `[...]` copies also stop this mutating the CALLER's `filters.AND`.
  const { AND: whereAnd, ...whereRest } = (where ?? {}) as DbFilters<T> & { AND?: unknown[] };
  const { AND: filtersAnd, ...filtersRest } = (filters ?? {}) as DbFilters<T> & { AND?: unknown[] };

  /* eslint-disable @typescript-eslint/no-explicit-any -- the generic `T` cannot describe Prisma's per-model AND element shape */
  let whereConditions: DbFilters<T> = {};
  if (filtersAnd && whereAnd) {
    whereConditions = { ...filtersRest, ...whereRest } as DbFilters<T>;
    whereConditions.AND = [...filtersAnd, ...whereAnd] as any;
  } else if (filtersAnd) {
    whereConditions = { ...filtersRest } as DbFilters<T>;
    whereConditions.AND = [...filtersAnd] as any;
    if (where) (whereConditions.AND as any[]).push(where);
  } else if (whereAnd) {
    whereConditions = { ...whereRest } as DbFilters<T>;
    whereConditions.AND = [...whereAnd] as any;
    if (filters) (whereConditions.AND as any[]).push(filters);
  } else {
    whereConditions = { ...filtersRest, ...whereRest } as DbFilters<T>;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  if (search && searchFields && searchFields.length > 0) {
    const searchConditions = searchFields.map((field) => ({
      [field]: { contains: search, mode: 'insensitive' },
    }));
    if (whereConditions.AND) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `searchConditions` is built from a runtime `searchFields` string array, so its shape can't be checked against the generic `DbFilters<T>` at this call site
      whereConditions.AND.push({ OR: searchConditions } as any);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same reason as the branch above
      whereConditions.AND = [{ OR: searchConditions } as any];
    }
  }

  const sortOptions: { [key: string]: 'asc' | 'desc' }[] = [];
  if (sort) {
    sort.forEach((sortEntry) => {
      const [field, order] = Object.entries(sortEntry)[0];
      sortOptions.push({ [field]: order });
    });
  }

  return {
    skip,
    take: limit,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- this generic helper's `T` isn't concrete enough to guarantee `whereConditions` matches Prisma's generated per-model where-input shape at the call site
    where: whereConditions as any,
    orderBy: sortOptions.length > 0 ? sortOptions : undefined,
  };
}

export function formatCountProps<T = DefaultDbFieldType>({ filters, search, searchFields, where }: ICountProps<T>) {
  let whereConditions = filters || {};
  if (where) {
    whereConditions = {
      AND: [where, whereConditions],
    };
  }

  if (search && searchFields && searchFields.length > 0) {
    whereConditions = {
      AND: [
        whereConditions,
        {
          OR: searchFields.map((field) => ({
            [field]: { contains: search, mode: 'insensitive' },
          })),
        },
      ],
    };
  }

  return {
    where: whereConditions,
  };
}
