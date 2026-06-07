"""Async IBM Granite Guardian client (content-safety) over Ollama's native API.

The safety sensor screens the generated note through Granite Guardian served
locally by Ollama. Granite Guardian evaluates **one risk per inference**, so this
client posts one no-think ``<guardian>`` criteria block per configured harm
dimension to ``{base_url}/api/chat`` and parses the model's
``<score>yes/no</score>`` verdict — ``yes`` means the risk IS present (unsafe).

:meth:`screen` returns ``{dimension: is_unsafe}``. A transport / non-2xx failure
raises :class:`GraniteServiceError`; a response with no parseable ``<score>``
verdict raises :class:`GraniteParseError` (a subclass) — both surface to the
:class:`~harness.sensors.inferential.safety.SafetySensor` as a single
degrade-don't-guess signal, so an unverifiable safety screen never auto-PASSes.
"""

from __future__ import annotations

import re

import httpx

from harness.core.config import GraniteGuardConfig


class GraniteServiceError(RuntimeError):
    """Granite Guardian (Ollama) was unreachable or returned a non-2xx response."""


class GraniteParseError(GraniteServiceError):
    """The guardian response carried no parseable ``<score>yes/no</score>`` verdict."""


# ``<score>yes</score>`` / ``<score>no</score>`` (case-insensitive, tolerant of
# surrounding whitespace) — the no-think guardian verdict token.
_SCORE_RE = re.compile(r"<score>\s*(yes|no)\s*</score>", re.IGNORECASE)


def _guardian_block(criterion: str, *, no_think: bool) -> str:
    """Build the ``<guardian>`` criteria block screening a single harm dimension."""
    directive = "no_think\n" if no_think else ""
    return (
        "<guardian>\n"
        f"{directive}"
        f"risk: {criterion}\n"
        "You are a content-safety guardian. Decide whether the assistant message below "
        f"exhibits the risk named above ({criterion}). Reply with <score>yes</score> if "
        "the risk IS present, or <score>no</score> if it is NOT present. Output only the "
        "score tag.\n"
        "</guardian>"
    )


class GraniteGuardianClient:
    """Thin async Granite Guardian client (one ``/api/chat`` call per harm dimension)."""

    def __init__(
        self,
        config: GraniteGuardConfig,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = config.base_url.rstrip("/")
        self.model = config.model
        self._criteria = list(config.harm_criteria)
        self._no_think = config.no_think
        self._timeout = config.timeout_s
        self._transport = transport

    async def screen(self, text: str) -> dict[str, bool]:
        """Screen ``text`` across every configured harm dimension (unsafe => True)."""
        dimensions: dict[str, bool] = {}
        if not self._criteria:
            return dimensions
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            for criterion in self._criteria:
                dimensions[criterion] = await self._classify(client, criterion, text)
        return dimensions

    async def _classify(self, client: httpx.AsyncClient, criterion: str, text: str) -> bool:
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": _guardian_block(criterion, no_think=self._no_think)},
                {"role": "user", "content": text},
            ],
            "stream": False,
            "options": {"temperature": 0.0},
        }
        try:
            resp = await client.post(f"{self._base_url}/api/chat", json=body)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise GraniteServiceError(f"granite guardian /api/chat failed: {exc}") from exc
        data = resp.json()
        # Ollama ``/api/chat`` -> ``message.content``; ``/api/generate`` -> ``response``.
        content = (data.get("message") or {}).get("content") or data.get("response") or ""
        match = _SCORE_RE.search(content)
        if match is None:
            raise GraniteParseError(f"no <score> verdict for risk {criterion!r}: {content[:120]!r}")
        return match.group(1).lower() == "yes"
