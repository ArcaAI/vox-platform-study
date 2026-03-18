/* eslint-disable @typescript-eslint/no-explicit-any */
export type QueryBuilderArgContext = Record<string, unknown>;

// export type Predicate<DataModel> = (item: DataModel) => boolean;
export type Predicate<DataModel> =
    | Partial<{
          [K in keyof DataModel]: any;
      }>
    | { path: string; query: Predicate<any> };

export type SelectClause<DataModel> = {
    [K in keyof DataModel]?: boolean;
};

export type IncludeClause<DataModel> = {
    [K in keyof DataModel]?:
        | boolean
        | IncludeClause<DataModel[K]>
        | { include: IncludeClause<DataModel[K]> };
} & {
    _count?: {
        select: {
            [key in keyof DataModel]?: boolean;
        };
    };
};
interface LogicalQuery<DataModel> {
    AND?: Predicate<DataModel>[];
    OR?: Predicate<DataModel>[];
    NOT?: Predicate<DataModel>[];
}

export interface Query<DataModel> {
    where?: LogicalQuery<DataModel>;
    select?: SelectClause<DataModel>;
    orderBy?: Array<{ [K in keyof DataModel]?: 'asc' | 'desc' }>;
    take?: number;
    skip?: number;
    include?: IncludeClause<DataModel>;
}

export class QueryBuilder<DataModel> {
    private whereClause: LogicalQuery<DataModel> = {};
    private selectClause?: SelectClause<DataModel>;
    private orderByClauses: Array<
        Partial<Record<keyof DataModel, 'asc' | 'desc'>>
    > = [];
    private takeClause: number | undefined;
    private skipClause: number | undefined;
    private includeClause: IncludeClause<DataModel> = {};
    constructor(private readonly dbContext: any) {}

    Where(predicate: Predicate<DataModel>): this {
        if (!this.whereClause.AND) {
            this.whereClause.AND = [];
        }
        // Handle deep relation path and filter
        if ('path' in predicate && 'query' in predicate) {
            this.whereClause.AND.push(
                buildNestedRelationFilter(
                    predicate.path,
                    predicate.query,
                ) as Predicate<DataModel>,
            );
        } else {
            this.whereClause.AND.push(predicate);
        }
        return this;
    }

    WhereOr(predicate: Predicate<DataModel>): this {
        if (!this.whereClause.OR) {
            this.whereClause.OR = [];
        }
        // Handle deep relation path and filter
        if ('path' in predicate && 'query' in predicate) {
            this.whereClause.OR.push(
                buildNestedRelationFilter(
                    predicate.path,
                    predicate.query,
                ) as Predicate<DataModel>,
            );
        } else {
            this.whereClause.OR.push(predicate);
        }
        return this;
    }

    WhereAnd(predicate: Predicate<DataModel>): this {
        return this.Where(predicate);
    }

    WhereNot(predicate: Predicate<DataModel>): this {
        if (!this.whereClause.NOT) {
            this.whereClause.NOT = [];
        }
        // Handle deep relation path and filter
        if ('path' in predicate && 'query' in predicate) {
            this.whereClause.NOT.push(
                buildNestedRelationFilter(
                    predicate.path,
                    predicate.query,
                ) as Predicate<DataModel>,
            );
        } else {
            this.whereClause.NOT.push(predicate);
        }
        return this;
    }

    Select<K extends keyof DataModel>(
        fields: K[],
    ): QueryBuilder<Pick<DataModel, K>> {
        this.selectClause = fields.reduce((acc, field) => {
            acc[field] = true;
            return acc;
        }, {} as SelectClause<DataModel>);
        return this as unknown as QueryBuilder<Pick<DataModel, K>>;
    }

    OrderBy<K extends keyof DataModel>(
        fields: K[],
        direction: 'asc' | 'desc' = 'asc',
    ): this {
        fields.forEach((field) => {
            this.orderByClauses.push({ [field]: direction } as Partial<
                Record<keyof DataModel, 'asc' | 'desc'>
            >);
        });
        return this;
    }

    Take(limit: number): this {
        this.takeClause = limit;
        return this;
    }

    Skip(offset: number): this {
        this.skipClause = offset;
        return this;
    }

    Include<K extends keyof DataModel>(
        relations: Partial<Record<K, boolean | IncludeClause<any>>>,
    ): this {
        for (const key in relations) {
            if (Object.prototype.hasOwnProperty.call(relations, key)) {
                const value = relations[key];
                if (typeof value === 'boolean' || typeof value === 'object') {
                    this.includeClause[key as K] =
                        value as IncludeClause<DataModel>[K];
                }
            }
        }
        return this;
    }

    CountRelation<K extends keyof DataModel>(
        relation: K,
        alias?: string,
    ): this {
        // Ensure includeClause and _count are properly initialized and typed
        if (!this.includeClause) {
            this.includeClause = {} as IncludeClause<DataModel>;
        }

        // Initialize _count if it is undefined
        if (!this.includeClause._count) {
            this.includeClause._count = { select: {} };
        }

        // Ensure _count has the correct shape with 'select' property
        if (
            typeof this.includeClause._count === 'object' &&
            !('select' in this.includeClause._count)
        ) {
            this.includeClause._count = {
                select: {} as { [key in keyof DataModel]?: boolean },
            };
        }

        // Use type assertion to access select safely
        if (alias) {
            // Add the relation count under the alias within the select clause
            (this.includeClause._count.select as Record<string, boolean>)[
                alias
            ] = true;
        } else {
            // Add the relation count directly within the select clause
            (this.includeClause._count.select as Record<string, boolean>)[
                relation as string
            ] = true;
        }

        return this;
    }

    Build(): Query<DataModel> {
        const query: Query<DataModel> = {
            where: this.whereClause,
            orderBy: this.orderByClauses,
            take: this.takeClause,
            skip: this.skipClause,
            include: this.includeClause,
        };

        if (this.selectClause) {
            query.select = this.selectClause;
        }

        return query;
    }

    Debug(): void {
        const query = this.Build();
        console.log(
            'Prisma Query:',
            JSON.stringify(
                {
                    where: query.where,
                    select: query.select,
                    orderBy: query.orderBy,
                    take: query.take,
                    skip: query.skip,
                    include: query.include,
                },
                null,
                2,
            ),
        );
    }

    async ToList(): Promise<DataModel[]> {
        const query = this.Build();
        return await await this.dbContext.findMany({
            where: query.where,
            select: query.select,
            orderBy: query.orderBy,
            take: query.take,
            skip: query.skip,
            include: query.include,
        });
    }

    async Single(predicate: Predicate<DataModel>): Promise<DataModel | null> {
        const query = this.Build();
        const result = await this.dbContext.findMany({
            where: query.where,
            select: query.select,
            orderBy: query.orderBy,
            take: query.take,
            skip: query.skip,
            include: query.include,
        });
        const filteredResult = result.filter(predicate);
        if (filteredResult.length !== 1) {
            throw new Error(
                'Single query returned more than one result or no result',
            );
        }
        return filteredResult[0];
    }
}

function getKey<DataModel, K extends keyof DataModel>(
    keyFn: (x: DataModel) => DataModel[K],
): K {
    const match = keyFn.toString().match(/return\s+([a-zA-Z0-9_]+)/);
    const key = match ? match[1] : null;
    return key as K;
}

function buildNestedRelationFilter(
    path: string,
    filter: Predicate<any>,
): Predicate<any> {
    const parts = path.split('.');
    return parts.reduceRight((acc, part) => {
        // Check if the part is prefixed with $ indicating an array needing `some`
        if (part.startsWith('$')) {
            return { [part.slice(1)]: { some: acc } }; // Remove $ and wrap with some
        } else {
            return { [part]: acc }; // Regular nested object
        }
    }, filter);
}
