"""Pinned HF ``tokenizer.json`` loader/cache for the ``/tokenize`` fallback lane.

The tokenizer a model uses is MODEL METADATA (``AiModel._metadata.tokenizer``:
``{hubRepo, file, sha256}``) and arrives per request; nothing here names a model
or a repo. A file whose digest differs from the pinned one is refused, so a
moved upstream revision cannot silently change a count. Loaded tokenizers are
cached per ``(hubRepo, sha256)``.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Awaitable, Callable
from pathlib import Path

import structlog
from tokenizers import Tokenizer

logger = structlog.get_logger(__name__)

Fetcher = Callable[[str, str], Awaitable[Path]]


class TokenizerUnavailableError(Exception):
    """No usable tokenizer could be produced for the request."""


async def _hub_fetch(repo: str, file: str) -> Path:
    from huggingface_hub import hf_hub_download

    return Path(await asyncio.to_thread(hf_hub_download, repo_id=repo, filename=file))


class TokenizerRegistry:
    def __init__(self, fetcher: Fetcher | None = None) -> None:
        self._fetcher = fetcher or _hub_fetch
        self._cache: dict[tuple[str, str], Tokenizer] = {}
        self._lock = asyncio.Lock()

    async def get(self, hub_repo: str, file: str, sha256: str) -> Tokenizer:
        key = (hub_repo, sha256.lower())
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        async with self._lock:
            cached = self._cache.get(key)
            if cached is not None:
                return cached
            try:
                path = await self._fetcher(hub_repo, file)
                data = await asyncio.to_thread(path.read_bytes)
            except Exception as exc:  # noqa: BLE001 — any fetch failure => unavailable
                logger.warning("tokenizer.fetch_failed", repo=hub_repo, error=str(exc))
                raise TokenizerUnavailableError("tokenizer file could not be fetched") from exc
            if hashlib.sha256(data).hexdigest() != sha256.lower():
                raise TokenizerUnavailableError("tokenizer file digest does not match the pin")
            try:
                tokenizer = Tokenizer.from_str(data.decode("utf-8"))
            except Exception as exc:  # noqa: BLE001
                raise TokenizerUnavailableError("tokenizer file is not loadable") from exc
            self._cache[key] = tokenizer
            return tokenizer


def count(tokenizer: Tokenizer, text: str) -> int:
    return len(tokenizer.encode(text, add_special_tokens=False).ids)
