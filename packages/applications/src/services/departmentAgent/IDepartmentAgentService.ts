import {
  CreateDepartmentAgentRequest,
  UpdateDepartmentAgentRequest,
  CloneDepartmentAgentRequest,
  DepartmentAgentResponse,
  DepartmentAgentVersionResponse,
  PaginatedDepartmentAgentResponse,
} from './dto';
import { PaginatedQuery } from '../../common';

export const IDepartmentAgentService = Symbol('IDepartmentAgentService');

export interface IDepartmentAgentService {
  list(query: PaginatedQuery, departmentId?: string): Promise<PaginatedDepartmentAgentResponse>;
  getById(id: string): Promise<DepartmentAgentResponse>;
  create(dto: CreateDepartmentAgentRequest): Promise<DepartmentAgentResponse>;
  update(id: string, dto: UpdateDepartmentAgentRequest): Promise<DepartmentAgentResponse>;
  deleteById(id: string): Promise<DepartmentAgentResponse>;
  setDefault(id: string): Promise<DepartmentAgentResponse>;
  pin(id: string, versionNumber: number | null): Promise<DepartmentAgentResponse>;
  clone(id: string, dto: CloneDepartmentAgentRequest): Promise<DepartmentAgentResponse>;
  /** TASK-674 — immutable loop-configuration version history, newest first. */
  listVersions(id: string): Promise<DepartmentAgentVersionResponse[]>;
}
