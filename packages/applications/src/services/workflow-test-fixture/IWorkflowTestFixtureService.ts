import {
  CreateWorkflowTestFixtureRequest,
  UpdateWorkflowTestFixtureRequest,
  WorkflowTestFixtureResponse,
  PaginatedWorkflowTestFixtureResponse,
} from './dto';
import { PaginatedQuery } from '../../common';
import { IBaseService } from '../../interfaces';

export interface IWorkflowTestFixtureService extends IBaseService {
  create(request: CreateWorkflowTestFixtureRequest): Promise<WorkflowTestFixtureResponse>;
  findAll(query: PaginatedQuery): Promise<PaginatedWorkflowTestFixtureResponse>;
  findById(id: string): Promise<WorkflowTestFixtureResponse>;
  update(id: string, request: UpdateWorkflowTestFixtureRequest): Promise<WorkflowTestFixtureResponse>;
  deleteById(id: string): Promise<WorkflowTestFixtureResponse>;
}
export const IWorkflowTestFixtureService = Symbol('IWorkflowTestFixtureService');
