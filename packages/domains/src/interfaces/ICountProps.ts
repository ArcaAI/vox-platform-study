import { DbFilters, DefaultDbFieldType } from './databaseTypes';

export interface ICountProps<T = DefaultDbFieldType> {
    search?: string;
    searchFields?: string[];
    filters?: DbFilters<T>;
    where?: DbFilters<T>;
}
