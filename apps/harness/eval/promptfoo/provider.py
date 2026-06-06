"""promptfoo provider: the model-agnostic PDSQI-9 judge for the eval gate.

* **Offline default** — a DETERMINISTIC mock that returns schema-valid PDSQI-9
  JSON (echoing the fixture clinician scores carried in ``vars``), so the gate
  runs in CI with no secrets and no network.
* **Real model** — set ``HARNESS_PROMPTFOO_BASE_URL`` + ``HARNESS_PROMPTFOO_API_KEY``
  (or ``OPENAI_BASE_URL`` + ``OPENAI_API_KEY``) to score against any
  OpenAI-compatible endpoint (LM Studio / vLLM / Azure) for nightly/full runs.

Uses only the Python stdlib (``urllib``) so the promptfoo lane has no pip deps.
"""

from __future__ import annotations

import json
import os
from typing import Any

# Valid neutral default if a case carries no clinician scores.
_DEFAULT_SCORES: dict[str, Any] = {
    "citation": 4,
    "accurate": 4,
    "thorough": 4,
    "useful": 4,
    "organized": 4,
    "comprehensible": 4,
    "succinct": 4,
    "synthesized": 4,
    "abstraction": 1,
    "voice_summ": 0,
    "voice_note": 0,
}


def call_api(prompt: str, options: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    """promptfoo provider entrypoint."""
    vars_ = (context or {}).get("vars", {}) or {}
    base_url = os.environ.get("HARNESS_PROMPTFOO_BASE_URL") or os.environ.get("OPENAI_BASE_URL")
    api_key = os.environ.get("HARNESS_PROMPTFOO_API_KEY") or os.environ.get("OPENAI_API_KEY")

    if base_url and api_key:
        try:
            return _call_openai_compatible(prompt, options or {}, base_url, api_key)
        except Exception as exc:  # surface transport errors to promptfoo
            return {"output": "", "error": f"judge endpoint call failed: {exc}"}

    # Offline deterministic mock.
    raw = vars_.get("_mock_pdsqi")
    try:
        scores = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        scores = {}
    return {"output": json.dumps({**_DEFAULT_SCORES, **scores})}


def _call_openai_compatible(
    prompt: str, options: dict[str, Any], base_url: str, api_key: str
) -> dict[str, Any]:
    from urllib.request import Request, urlopen

    config = options.get("config", {}) or {}
    model = config.get("model") or os.environ.get("HARNESS_PROMPTFOO_MODEL", "gpt-4o-mini")
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }
    ).encode("utf-8")
    request = Request(
        base_url.rstrip("/") + "/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    with urlopen(request, timeout=120) as response:  # noqa: S310 - configured endpoint
        payload = json.loads(response.read().decode("utf-8"))
    return {"output": payload["choices"][0]["message"]["content"]}
