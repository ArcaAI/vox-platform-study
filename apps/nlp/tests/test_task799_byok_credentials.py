"""NLP holds NO vendor credential plane — and this suite keeps it that way.

The sibling of `apps/text`'s `test_task602_byok_credentials.py`, for the NLP plane.
It asserts a NEGATIVE, deliberately.

`apps/nlp` is a pure EXECUTOR: it runs local model weights (gliner2, transformers,
llama.cpp) on platform hardware, and its only outbound calls are to PEER SERVICES —
`apps/text` for LLM judgement (`services/external_text_client.py`) and the gateway for
effective-config and registration. It authenticates those with the ONE shared internal
credential (`INTERNAL_ACCESS_TOKEN`, owner decision D-D), never with a vendor key. It
therefore has no BYOK cascade to implement, and inventing one would be a config surface
with nothing behind it.

**That is a fact about today's code, not a permanent property** — which is exactly why it
needs a lock. The moment someone adds an embeddings, rerank or cloud-NER adapter here, the
`provider_overrides` plane must come WITH it: a vendor SDK constructed with no explicit
credential authenticates from the process environment, which is how `bedrock` and `vertex`
kept ambient credential chains alive in `apps/text` for years. `06-python-services.md`
also forbids growing a second inference stack — a service needing LLM judgement calls
`apps/text`, which already owns the adapters and the BYOK plane.

The three guarantees:

  1. Every secret in the settings tree is a DECLARED internal credential. A new
     `SecretStr` fails until someone adds it to the allow-list below with a reason —
     the default-deny that makes this suite survive the next contributor.
  2. No env var can produce a vendor credential, however the env is populated.
  3. No vendor SDK is imported anywhere in the package. This is the guard that actually
     fires when someone adds an adapter: it fails at the import, before there is a
     credential to leak, and points them at the plane they must use instead.
"""

from __future__ import annotations

import ast
import pathlib

import pytest
from pydantic import BaseModel, SecretStr

from nlp.core.config import Settings

#: Every secret `apps/nlp` is permitted to hold, and WHY. Each entry is an INTERNAL
#: platform credential, not a vendor one. Adding a line here is the review moment: a
#: vendor credential does not belong in this service at all — it belongs in
#: `AiProviderConnection`, resolved tenant → SYSTEM and injected per request.
_ALLOWED_SECRETS: dict[str, str] = {
    "service.internal_access_token": (
        "The ONE shared internal credential (owner decision D-D, 2026-08-17), presented "
        "on peer calls to apps/text and the gateway. Platform identity, not vendor."
    ),
}

#: Vendor SDKs whose presence would mean this service had grown its own inference stack
#: and its own credential surface. Import names, matched on the ROOT module.
_VENDOR_SDKS = frozenset(
    {
        "boto3",
        "botocore",
        "openai",
        "anthropic",
        "google",
        "vertexai",
        "azure",
        "cohere",
        "mistralai",
        "sarvamai",
        "replicate",
        "together",
    }
)

_NLP_SRC = pathlib.Path(__file__).resolve().parents[1] / "src" / "nlp"


def _settings_secret_fields() -> list[str]:
    """Every leaf field in the settings tree whose declared type is a secret."""
    out: list[str] = []

    def walk(model: type[BaseModel], prefix: str) -> None:
        for name, field in model.model_fields.items():
            annotation = field.annotation
            if isinstance(annotation, type) and issubclass(annotation, BaseModel):
                walk(annotation, f"{prefix}{name}.")
            elif annotation is SecretStr or annotation == (SecretStr | None):
                out.append(f"{prefix}{name}")

    settings = Settings()
    for attr in ("service", "security", "text_corrector", "external_text"):
        sub = getattr(settings, attr)
        walk(type(sub), f"{attr}.")
    return sorted(out)


def _read(obj: object, dotted: str) -> object:
    for part in dotted.split("."):
        obj = getattr(obj, part, None)
        if obj is None:
            return None
    if isinstance(obj, SecretStr):
        return obj.get_secret_value()
    return obj


# ---------------------------------------------------------------------------
# 1 — every secret is a declared INTERNAL credential (default-deny)
# ---------------------------------------------------------------------------


def test_every_secret_field_is_a_declared_internal_credential():
    undeclared = [f for f in _settings_secret_fields() if f not in _ALLOWED_SECRETS]
    assert undeclared == [], (
        f"apps/nlp declares secret field(s) {undeclared} that are not on the internal "
        "allow-list. If this is a VENDOR credential it does not belong here at all: it "
        "belongs in AiProviderConnection, resolved tenant -> SYSTEM and injected per "
        "request as `provider_overrides` (see apps/text). If it is genuinely another "
        "internal platform credential, add it to _ALLOWED_SECRETS with the reason — "
        "note that owner decision D-D says there is exactly ONE."
    )


def test_the_allow_list_has_no_stale_entries():
    """A removed field left on the allow-list quietly widens what the next one may be."""
    declared = set(_settings_secret_fields())
    stale = [f for f in _ALLOWED_SECRETS if f not in declared]
    assert stale == [], f"_ALLOWED_SECRETS names field(s) {stale} that no longer exist."


def test_the_sweep_actually_found_the_internal_token():
    """Guard the guard: a walker that finds nothing makes test 1 vacuously pass."""
    assert "service.internal_access_token" in _settings_secret_fields()


# ---------------------------------------------------------------------------
# 2 — no env var can produce a vendor credential
# ---------------------------------------------------------------------------


_VENDOR_ENV_VARS = (
    "NLP_API_KEY",
    "NLP_OPENAI_API_KEY",
    "NLP_AZURE_API_KEY",
    "NLP_ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "GOOGLE_API_KEY",
    "HF_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
)


def test_no_vendor_env_var_reaches_the_settings_tree(monkeypatch):
    for var in _VENDOR_ENV_VARS:
        monkeypatch.setenv(var, "leaked-from-env")

    settings = Settings()
    leaked = [
        field
        for field in _settings_secret_fields()
        if _read(settings, field) == "leaked-from-env"
    ]
    assert leaked == [], (
        f"vendor env var(s) populated {leaked}. apps/nlp runs local weights and "
        "delegates LLM work to apps/text; it must hold no vendor credential."
    )


# ---------------------------------------------------------------------------
# 3 — no vendor SDK is imported anywhere in the package
# ---------------------------------------------------------------------------


def _imported_roots() -> dict[str, set[str]]:
    """Root module name -> the files importing it, across the whole package.

    Parsed with `ast` rather than grepped so a name inside a string, a comment or a
    docstring cannot produce a false positive — several modules legitimately DISCUSS
    these vendors in prose explaining why they are absent.
    """
    found: dict[str, set[str]] = {}
    for path in _NLP_SRC.rglob("*.py"):
        if "/tests/" in str(path):
            continue
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                # `level > 0` is a relative import — never a third-party SDK.
                roots = [node.module.split(".")[0]] if node.module and not node.level else []
            else:
                continue
            for root in roots:
                found.setdefault(root, set()).add(str(path.relative_to(_NLP_SRC)))
    return found


def test_the_import_sweep_actually_parsed_the_package():
    """Guard the guard: an empty sweep makes the vendor-SDK test vacuous."""
    roots = _imported_roots()
    assert "httpx" in roots, f"import sweep found no httpx; it parsed {len(roots)} roots"


@pytest.mark.parametrize("sdk", sorted(_VENDOR_SDKS))
def test_no_vendor_sdk_is_imported(sdk: str):
    """The guard that fires BEFORE there is a credential to leak.

    A vendor SDK here means apps/nlp has grown its own inference stack and its own
    credential surface — both of which `06-python-services.md` forbids, and neither of
    which the gateway injects for. Whoever hits this must either call apps/text /
    apps/nlp's existing peer clients, or bring the full `provider_overrides` plane
    (posture declaration, tenant -> SYSTEM cascade, fail-closed adapter, lock test)
    with the adapter.
    """
    importers = _imported_roots().get(sdk)
    assert not importers, (
        f"apps/nlp imports the vendor SDK {sdk!r} in {sorted(importers)}. This service "
        "runs local weights and delegates vendor work to peer services; it has no "
        "credential plane, so an SDK client built here would authenticate from the "
        "process environment. Route the call through a peer client, or implement the "
        "provider_overrides plane alongside the adapter."
    )
