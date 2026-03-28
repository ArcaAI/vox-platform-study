import { DbFilters, DefaultDbFieldType } from './databaseTypes';

export interface IFindAllProps<T = DefaultDbFieldType> {
  page?: number;
  limit?: number;
  search?: string;
  searchFields?: string[];
  filters?: DbFilters<T>;
  sort?: { [key: string]: 'asc' | 'desc' }[];
  where?: DbFilters<T>;
}
