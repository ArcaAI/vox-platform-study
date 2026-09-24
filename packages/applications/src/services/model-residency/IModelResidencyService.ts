import type {
  CreateModelResidencyPolicyRequest,
  LoadModelResidencyRequest,
  ModelResidencyLoadResponse,
  ModelResidencyOperationResponse,
  ModelResidencyPinResponse,
  ModelResidencyPolicyResponse,
  ModelResidencyUnloadResponse,
  ModelResidencyViewResponse,
  PinModelResidencyRequest,
  UnloadModelResidencyRequest,
  UpdateModelResidencyPolicyRequest,
} from './dto';

export const IModelResidencyService = Symbol('IModelResidencyService');

/** A load answers 202 when admitted (async) and 200 when the model is already resident. */
export interface ModelResidencyLoadResult {
  status: 200 | 202;
  body: ModelResidencyLoadResponse;
}

/**
 * TASK-1005 — the model-residency control plane: ONE decision-maker over
 * model load / unload / pin across stt, nlp and LM Studio (stt-worker is
 * observed, never commanded).
 *
 * PLATFORM ADMIN ONLY, imperatively, on every method: SUPER_ADMIN in a
 * tenant-LESS context (D-11 — tenants never see this surface). The gate is
 * row-INDEPENDENT, so it runs FIRST (the promote-to-system ordering in
 * `05-nestjs-api.md`): 403 for a tenant admin, and 403 for a super admin with a
 * working tenant selected. An unknown model or policy id is still a 404 after it.
 */
export interface IModelResidencyService {
  /** Devices, resident models (enriched with Prometheus rates), recommendations and freshness. */
  getView(): Promise<ModelResidencyViewResponse>;

  /** Admit a load: 202 + operation (async), 200 `already_loaded`, or 400/404/409. */
  load(request: LoadModelResidencyRequest): Promise<ModelResidencyLoadResult>;

  /** Synchronous unload; 409 `IN_FLIGHT` unless `force`. */
  unload(request: UnloadModelResidencyRequest): Promise<ModelResidencyUnloadResponse>;

  /** Pin/unpin (+ TTL) through the agent's policy verb; controller-side for LM Studio. */
  pin(request: PinModelResidencyRequest): Promise<ModelResidencyPinResponse>;

  getOperation(operationId: string): Promise<ModelResidencyOperationResponse>;

  listPolicies(): Promise<ModelResidencyPolicyResponse[]>;
  createPolicy(request: CreateModelResidencyPolicyRequest): Promise<ModelResidencyPolicyResponse>;
  updatePolicy(id: string, request: UpdateModelResidencyPolicyRequest): Promise<ModelResidencyPolicyResponse>;
  deletePolicy(id: string): Promise<ModelResidencyPolicyResponse>;
}
