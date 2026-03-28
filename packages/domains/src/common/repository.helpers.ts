import { DbFilters, DefaultDbFieldType, ICountProps, IFindAllProps } from '../interfaces';

export function formatFindAllProps<T = DefaultDbFieldType>({ page, limit, filters, search, searchFields, sort, where }: IFindAllProps<T>) {
  let skip = 0;
  if (page != null && limit) {
    skip = Math.max(0, (page - 1) * limit);
  }

  let whereConditions: DbFilters<T> = {};

  // Merge filters and where conditions into a single AND condition array if both are provided
  if (filters && filters.AND && where && where.AND) {
    whereConditions.AND = [...filters.AND, ...where.AND];
  } else if (filters && filters.AND) {
    whereConditions.AND = filters.AND;
    if (where) whereConditions.AND.push(where);
  } else if (where && where.AND) {
    whereConditions.AND = where.AND;
    if (filters) whereConditions.AND.push(filters);
  } else {
    if (filters) whereConditions = filters;
    if (where) whereConditions = { ...whereConditions, ...where };
  }

  if (search && searchFields && searchFields.length > 0) {
    const searchConditions = searchFields.map((field) => ({
      [field]: { contains: search, mode: 'insensitive' },
    }));
    if (whereConditions.AND) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      whereConditions.AND.push({ OR: searchConditions } as any);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
