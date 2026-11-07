# API Gateway B06a — Model, Provider & Routing

Companion explainer for `api-gateway-b06a-model-provider-routing.html`.

## Scope
`B06a` (part of B06-ai-platform, reconciled from `inventory/modules.json`): `ai-model` (26/5), `model-residency` (14/1), `ai-provider-connection` (8/1), `ai-routing-policy` (11/1), `ai-service-admin` (9/1) — **68 routes / 9 controllers**. Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Modules/routes | Controllers | Key services | Downstream |
|---|---|---|---|---|
| AI model registry | `/admin/ai-models` catalogue/admin/registration/discovery/jobs (26, 5 controllers) | `AiModelAdminController`, `AiModelCatalogueController`, `AiModelRegistrationController`, `AiModelDiscoveryController`, `AiModelJobsController` (`ai-model/*.controller.ts`) | `AiModelService` (`aiModel.service.ts:251`), `AiModelDownloadService` (`publish/ai-model-download.service.ts:139`), `AiModelUnregisterService` (`publish/model-unregister.service.ts:71`) | Model registry/config; model artifacts/external targets |
| Model residency | `/admin/model-residency` (14) | `ModelResidencyController` (`model-residency.controller.ts:46`) | `ModelResidencyService` (`model-residency.service.ts:449`) | Residency policy/state |
| Provider & routing | `/admin/providers` (8) + `/admin/routing-policies` (11) | `ProviderConnectionController` (`ai-provider-connection.controller.ts:97`), `AiRoutingPolicyAdminController` (`ai-routing-policy-admin.controller.ts:84`) | `AiProviderConnectionService` (`ai-provider-connection.service.ts:132`), `AiRoutingPolicyService` (`ai-routing-policy.service.ts:140`) | Provider/routing config; external AI providers |
| AI service admin | `/admin/ai-services` (9) | `AiServiceAdminController` (`ai-service-admin.controller.ts:39`) | Delegated to AI platform service wiring (service implementation path not separately verified) | AI service config |

## Example input/output (representative)
- **Model registration/discovery/jobs:** admin requests register/discover/download/unregister models or manage model jobs -> model registry records/job metadata. Verify artifact URLs, credentials, and async job behavior.
- **Model residency:** policy/state CRUD requests -> residency policy/state responses (data residency constraints).
- **Provider connection/routing policy:** create/update provider credentials/endpoints and routing rules -> resolved provider/routing config. Verify secret/authref handling and policy precedence.
- **AI service admin:** service configuration requests -> AI service config records. Verify exact DTOs and service wiring.

## Validation / limitations
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Advisory route readability: 2 crossings and 1 detour (`svc_models→ext_prov`, 4 bends). Gates pass.
- Limitations: grouped endpoint nodes (68 routes/9 controllers); AI model cluster cited with representative controller sources (5 controllers total); `AiServiceAdmin` service implementation path not separately verified; secret/authref/model artifact handling and routing precedence are implementation-specific — reconcile with OpenAPI/implementation.
