import { DepartmentResponse, CreateDepartmentRequest, UpdateDepartmentRequest, UpdateDepartmentPromptConfigRequest } from './dto';

export abstract class IDepartmentService {
  abstract getAll(options?: { includeDisabled?: boolean }): Promise<DepartmentResponse[]>;
  abstract getById(id: string): Promise<DepartmentResponse | null>;
  abstract getByCode(code: string): Promise<DepartmentResponse | null>;
  abstract getRootDepartments(): Promise<DepartmentResponse[]>;
  abstract getChildren(parentId: string): Promise<DepartmentResponse[]>;
  abstract create(dto: CreateDepartmentRequest): Promise<DepartmentResponse>;
  abstract update(id: string, dto: UpdateDepartmentRequest): Promise<DepartmentResponse>;
  abstract updatePromptConfig(id: string, dto: UpdateDepartmentPromptConfigRequest): Promise<DepartmentResponse>;
  abstract deleteById(id: string): Promise<DepartmentResponse>;
}
