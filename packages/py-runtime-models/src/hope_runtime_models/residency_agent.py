"""The residency agent: one service's resident models, and the verbs on them (TASK-1005).

The gateway ``ModelResidencyController`` is the single decision-maker (plan D-1);
each Python service is a data plane that executes its commands locally and reports
what it holds. This module is that data plane, implemented once for every service:

* :meth:`ResidencyAgent.report` — the ``GET /internal/residency`` body;
* :meth:`ResidencyAgent.load` / :meth:`unload` / :meth:`set_policy` — the verbs.

Shapes are the ``python`` block of ``tests/contracts/model-residency-agent.fixture.json``
(snake_case), pinned before any lane branched. The HTTP skin is
:func:`hope_runtime_models.residency_api.build_residency_router`.

What the agent does NOT know is how a service turns a ``model_ref`` + ``load_spec``
into a load. That is the service's ``planner``: it answers with the cache, the
key and a coroutine that loads through the cache's normal path (so single-flight,
pressure relief, admission and measurement all apply), or None when the spec does
not describe a model it can load.
"""

from __future__ import annotations

import inspect
import os
import socket
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from . import vram
from .accelerator import torch_reserved_bytes
from .cache import UNSET, AdmissionRejected, LoadFailure, ModelInFlightError, ResidentModel
from .devices import nvml_index_for


@dataclass(frozen=True)
class ModelIdentity:
    """How a cache key is named on the wire."""

    model_ref: str
    ai_model_id: str | None = None


def _key_is_model_ref(key: str, _instance: Any) -> ModelIdentity:
    return ModelIdentity(model_ref=key)


@dataclass(frozen=True)
class CacheBinding:
    """One residency-wired cache the agent reports on and acts through."""

    cache: Any
    describe: Callable[[str, Any], ModelIdentity] = field(default=_key_is_model_ref)


@dataclass(frozen=True)
class LoadPlan:
    """A service's answer to "load ``model_ref`` from this ``load_spec``"."""

    cache: Any
    key: str
    load: Callable[[], Awaitable[Any]]


class Planner(Protocol):
    """Turns ``(model_ref, load_spec, device)`` into a :class:`LoadPlan` (TASK-1055).

    ``device`` is the requested device id (``cuda:<n>`` / ``cpu``) or ``None`` for the
    service's default placement. A planner that cannot place on ``device`` raises
    :class:`DeviceUnavailable`; the returned plan's ``cache`` MUST be bound to that
    device (``plan.cache.residency.device.id == device``).
    """

    def __call__(
        self, model_ref: str, load_spec: dict[str, Any], *, device: str | None = None
    ) -> Awaitable[LoadPlan | None]: ...


class InvalidLoadSpec(ValueError):
    """A planner could not read the ``load_spec`` it was given (HTTP 400)."""


class DeviceUnavailable(ValueError):
    """The requested device does not exist here or cannot host the model.

    HTTP 400 ``DEVICE_UNAVAILABLE``.
    """


class ResidencyError(Exception):
    """A refused verb, carrying the contract's error ``code`` and HTTP status."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int,
        extra: dict[str, Any] | None = None,
        retry_after_seconds: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra or {}
        self.retry_after_seconds = retry_after_seconds

    def body(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message, **self.extra}}


def _model_unknown(model_ref: str) -> ResidencyError:
    return ResidencyError(
        "MODEL_UNKNOWN",
        f"{model_ref} is not resident here and no usable load_spec names it",
        status=404,
    )


def _in_flight(model_ref: str, in_flight: int) -> ResidencyError:
    return ResidencyError(
        "IN_FLIGHT",
        f"{model_ref} is serving {in_flight} request(s); pass force=true to unload anyway",
        status=409,
        extra={"in_flight": in_flight},
    )


def _iso(epoch_seconds: float) -> str:
    return datetime.fromtimestamp(epoch_seconds, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _error_json(failure: LoadFailure) -> dict[str, Any]:
    return {"code": failure.code, "message": failure.message, "at": _iso(failure.at)}


async def _settle(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


@dataclass(frozen=True)
class _Found:
    binding: CacheBinding
    model: ResidentModel


class ResidencyAgent:
    """Reports and controls the residency-wired caches of one service process."""

    def __init__(
        self,
        *,
        service: str,
        bindings: Callable[[], Iterable[CacheBinding]],
        planner: Planner | None = None,
        devices: Callable[[], Iterable[Any]] | None = None,
        instance: str | None = None,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._service = service
        self._bindings = bindings
        self._planner = planner
        #: Devices to report even while no cache on them exists yet (lazy caches).
        self._devices = devices
        self._instance = instance or os.environ.get("HOSTNAME") or socket.gethostname()
        self._wall_clock = wall_clock

    # ── read side ───────────────────────────────────────────────────────────

    def report(self) -> dict[str, Any]:
        now = self._wall_clock()
        devices: dict[str, Any] = {
            device.id: device for device in (self._devices() if self._devices else ())
        }
        models: list[dict[str, Any]] = []
        for binding in self._live_bindings():
            device = binding.cache.residency.device
            devices.setdefault(device.id, device)
            for model in binding.cache.residency_snapshot():
                models.append(self._model_json(binding, model, now))
        return {
            "service": self._service,
            "instance": self._instance,
            "reported_at": _iso(now),
            "devices": [self._device_json(device) for device in devices.values()],
            "models": models,
        }

    # ── verbs ───────────────────────────────────────────────────────────────

    async def load(
        self,
        model_ref: str,
        load_spec: dict[str, Any],
        *,
        pin: bool,
        ttl_seconds: int | None,
        device: str | None = None,
    ) -> dict[str, Any]:
        plan = await self._plan(model_ref, load_spec, device)
        if plan is None:
            found = self._find(model_ref, device)
            if not found:
                raise _model_unknown(model_ref)
            await self._apply_load_policy(found, pin=pin, ttl_seconds=ttl_seconds)
            return {"outcome": "already_loaded", "model": self._model_json_for(found[0])}

        resident = self._find_key(plan.cache, plan.key)
        if resident is not None:
            await self._apply_load_policy([resident], pin=pin, ttl_seconds=ttl_seconds)
            return {"outcome": "already_loaded", "model": self._model_json_for(resident)}

        device = plan.cache.residency.device
        if not device.try_reserve(plan.key):
            raise ResidencyError(
                "LOAD_IN_PROGRESS",
                f"{device.id} is loading another model; loads are serialised per device",
                status=409,
            )
        try:
            await plan.load()
        except AdmissionRejected as exc:
            raise ResidencyError(
                "INSUFFICIENT_MEMORY",
                str(exc),
                status=503,
                extra={
                    "device": exc.device_id,
                    "needed_bytes": exc.needed_bytes,
                    "free_bytes": exc.free_bytes,
                    "headroom_bytes": exc.headroom_bytes,
                },
                retry_after_seconds=exc.retry_after_seconds,
            ) from exc
        except ResidencyError:
            raise
        except Exception as exc:  # noqa: BLE001 — every load failure is LOAD_FAILED
            raise ResidencyError(
                "LOAD_FAILED", f"{model_ref} failed to load: {exc}", status=500
            ) from exc
        finally:
            device.release(plan.key)

        loaded = self._find_key(plan.cache, plan.key)
        if loaded is None:
            raise ResidencyError(
                "LOAD_FAILED",
                f"{model_ref} loaded but was evicted before it could be reported",
                status=500,
            )
        await self._apply_load_policy([loaded], pin=pin, ttl_seconds=ttl_seconds)
        return {"outcome": "loaded", "model": self._model_json_for(loaded)}

    async def unload(
        self, model_ref: str, *, force: bool, reason: str, device: str | None = None
    ) -> dict[str, Any]:
        # Keys only: a snapshot holds the model instance, and a reference kept across the
        # cache's unload would stop it from handing the memory back (TASK-1055 E6).
        targets, in_flight = self._unload_targets(model_ref, device)
        if in_flight and not force:
            raise _in_flight(model_ref, in_flight)

        # A model whose last load FAILED is not loaded, but an unload dismisses that failure
        # (outcome stays `not_loaded`: nothing was resident; the operator asked to forget it).
        for cache, key in self._failed_keys(model_ref, device):
            await _settle(cache.unload(key, force=force, reason=reason))

        unloaded = False
        for cache, key in targets:
            try:
                unloaded |= bool(await _settle(cache.unload(key, force=force, reason=reason)))
            except ModelInFlightError as exc:  # pinned between the check and the unload
                raise _in_flight(model_ref, exc.in_flight) from exc
        return {"outcome": "unloaded" if unloaded else "not_loaded", "model_ref": model_ref}

    async def set_policy(
        self, model_ref: str, *, admin_pinned: Any = UNSET, ttl_seconds: Any = UNSET
    ) -> dict[str, Any]:
        found = self._find(model_ref)
        if not found:
            raise _model_unknown(model_ref)
        for item in found:
            await _settle(
                item.binding.cache.set_policy(
                    item.model.key, admin_pinned=admin_pinned, ttl_seconds=ttl_seconds
                )
            )
        refreshed = self._find_key(found[0].binding.cache, found[0].model.key)
        return {"model": self._model_json_for(refreshed or found[0])}

    # ── internals ───────────────────────────────────────────────────────────

    def _live_bindings(self) -> list[CacheBinding]:
        return [b for b in self._bindings() if getattr(b.cache, "residency", None) is not None]

    async def _plan(
        self, model_ref: str, load_spec: dict[str, Any], device: str | None = None
    ) -> LoadPlan | None:
        if self._planner is None:
            if device is not None:
                raise ResidencyError(
                    "DEVICE_UNAVAILABLE",
                    f"{self._service} cannot place a load on {device}",
                    status=400,
                    extra={"device": device},
                )
            return None
        try:
            if device is None:  # a pre-TASK-1055 planner takes two arguments
                return await self._planner(model_ref, load_spec)
            return await self._planner(model_ref, load_spec, device=device)
        except InvalidLoadSpec as exc:
            raise ResidencyError("LOAD_FAILED", f"invalid load_spec: {exc}", status=400) from exc
        except DeviceUnavailable as exc:
            raise ResidencyError(
                "DEVICE_UNAVAILABLE", str(exc), status=400, extra={"device": device}
            ) from exc

    def _find(self, model_ref: str, device: str | None = None) -> list[_Found]:
        """Every LOADED slot whose key is named ``model_ref`` (any cache; one device if given)."""
        found: list[_Found] = []
        for binding in self._live_bindings():
            if device is not None and binding.cache.residency.device.id != device:
                continue
            for model in binding.cache.residency_snapshot():
                if model.state != "loaded":
                    continue
                if binding.describe(model.key, model.instance).model_ref == model_ref:
                    found.append(_Found(binding, model))
        return found

    def _unload_targets(
        self, model_ref: str, device: str | None
    ) -> tuple[list[tuple[Any, str]], int]:
        """``(cache, key)`` of every loaded copy, and their summed in-flight count."""
        found = self._find(model_ref, device)
        return [(item.binding.cache, item.model.key) for item in found], sum(
            item.model.in_flight for item in found
        )

    def _failed_keys(self, model_ref: str, device: str | None) -> list[tuple[Any, str]]:
        """``(cache, key)`` of every recorded failed load named ``model_ref``."""
        keys: list[tuple[Any, str]] = []
        for binding in self._live_bindings():
            if device is not None and binding.cache.residency.device.id != device:
                continue
            for model in binding.cache.residency_snapshot():
                if (
                    model.state == "failed"
                    and binding.describe(model.key, model.instance).model_ref == model_ref
                ):
                    keys.append((binding.cache, model.key))
        return keys

    def _find_key(self, cache: Any, key: str) -> _Found | None:
        for binding in self._live_bindings():
            if binding.cache is not cache:
                continue
            for model in cache.residency_snapshot():
                if model.key == key and model.state == "loaded":
                    return _Found(binding, model)
        return None

    async def _apply_load_policy(
        self, found: list[_Found], *, pin: bool, ttl_seconds: int | None
    ) -> None:
        """A load's ``pin`` only ever ADDS the operator pin; unpinning is a policy PUT."""
        if not pin and ttl_seconds is None:
            return
        for item in found:
            await _settle(
                item.binding.cache.set_policy(
                    item.model.key,
                    admin_pinned=True if pin else UNSET,
                    ttl_seconds=UNSET if ttl_seconds is None else ttl_seconds,
                )
            )

    def _model_json_for(self, item: _Found) -> dict[str, Any]:
        latest = self._find_key(item.binding.cache, item.model.key)
        chosen = latest or item
        return self._model_json(chosen.binding, chosen.model, self._wall_clock())

    def _model_json(
        self, binding: CacheBinding, model: ResidentModel, now: float
    ) -> dict[str, Any]:
        identity = binding.describe(model.key, model.instance)
        return {
            "model_ref": identity.model_ref,
            "ai_model_id": identity.ai_model_id,
            "cache": binding.cache.name,
            "state": model.state,
            "device": binding.cache.residency.device.id,
            "bytes": model.measured_bytes,
            "bytes_source": model.bytes_source if model.measured_bytes is not None else "unknown",
            "in_flight": model.in_flight,
            "pinned": model.in_flight > 0 or model.admin_pinned,
            "admin_pinned": model.admin_pinned,
            "ttl_seconds": model.ttl_seconds,
            "loaded_at": (
                None if model.loaded_seconds_ago is None else _iso(now - model.loaded_seconds_ago)
            ),
            "last_used_at": None if model.idle_seconds is None else _iso(now - model.idle_seconds),
            "load_seconds": None if model.load_seconds is None else round(model.load_seconds, 3),
            "error": None if model.error is None else _error_json(model.error),
        }

    @staticmethod
    def _device_json(device: Any) -> dict[str, Any]:
        """One ``devices[]`` entry (TASK-1055: + ``index``, ``name``, ``uuid``, ``process_bytes``).

        ``index`` is the NVML index behind ``cuda:<i>`` (``uuid`` is what the gateway
        matches against DCGM); ``process_bytes`` is what this process's torch holds on
        the card. Every extra is None when unknowable (and always for ``cpu``).
        """
        reading = device.memory()
        index = nvml_index_for(device.id) if device.kind == "gpu" else None
        return {
            "id": device.id,
            "kind": device.kind,
            "total_bytes": None if reading is None else reading.total_bytes,
            "free_bytes": None if reading is None else reading.free_bytes,
            "index": index,
            "name": None if index is None else vram.nvml_device_name(index),
            "uuid": None if index is None else vram.nvml_device_uuid(index),
            "process_bytes": torch_reserved_bytes(device.id) if device.kind == "gpu" else None,
        }
