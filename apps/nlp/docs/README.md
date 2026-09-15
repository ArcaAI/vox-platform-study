# NLP service documentation

Numbered developer guides for `apps/nlp`. These are historical, hand-written
docs (not regenerated) — verify a claim against the code in `../src/nlp/`
before relying on it for anything load-bearing; `../README.md` is the
up-to-date entry point for layout, commands, ports and configuration.

## Layout

| Path | What it holds |
|---|---|
| `01-architecture.md` | System architecture, layer-by-layer design, data flow, concurrency model |
| `02-api-reference.md` | REST/WebSocket endpoint reference, request/response formats, error responses |
| `03-models.md` | The ML models this service loads and their capabilities |
| `04-development-guide.md` | Environment setup, project structure, coding standards, testing |
| `05-configuration.md` | Environment variables and service/model/security configuration |
| `06-deployment.md` | Docker/Kubernetes deployment, monitoring, scaling |

## How it works

Start with `../README.md` for anything you need verified against the current
code (layout, commands, settings classes, endpoint list, auth). Come here for
narrative depth on one of the six topics above — architecture rationale, a
walkthrough of a specific endpoint's request/response shape, or the model
documentation. Where this set and `../README.md` disagree, `../README.md`
wins: it is checked against the code on every doc pass, these six files are
not.

## Related

- [`../README.md`](../README.md) — the authoritative, code-verified README for this service
- [`06-python-services.md`](../../../.claude/rules/06-python-services.md) — FastAPI service conventions
- [`docs/architecture/overview.md`](../../../docs/architecture/overview.md) — platform-wide architecture, topology, data flows
- [`apps/api` README](../../api/README.md) — the gateway that fronts this service
- [`infrastructure/README.md`](../../../infrastructure/README.md) — local infrastructure this service depends on
