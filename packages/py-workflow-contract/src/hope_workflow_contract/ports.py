"""Port tables — the Python mirror of ``node-ports.ts`` + the per-instance resolution of
``core-contract.ts`` (``effectivePorts`` / ``resolveInputPort`` / ``resolveOutputPort``).

Only what the binding mirror needs: the legacy edge → binding translation reads a data edge's
producer ``outputKey`` and the target's input primitive (a ``control`` port carries no data).
Held to the TypeScript tables through ``tests/contracts/bindings.fixture.json`` and
``node-io.fixture.json`` (``core.action``'s NodeIO is derived from its port table).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypedDict


class Port(TypedDict, total=False):
    name: str
    primitive: str
    required: bool
    multiple: bool
    outputKey: str


def _port(
    name: str, primitive: str, required: bool, multiple: bool, output_key: str | None = None
) -> Port:
    port: Port = {"name": name, "primitive": primitive, "required": required, "multiple": multiple}
    if output_key is not None:
        port["outputKey"] = output_key
    return port


def _control(name: str, required: bool = False, multiple: bool = True) -> Port:
    return {"name": name, "primitive": "control", "required": required, "multiple": multiple}


AFTER = _control("after")
NEXT = _control("next")

Ports = dict[str, list[Port]]


def _ports(inputs: list[Port], outputs: list[Port]) -> Ports:
    return {"inputs": inputs, "outputs": outputs}


NODE_PORTS: dict[str, Ports] = {
    "core.trigger": _ports([], [_port("out", "context<schemaRef>", True, True, "context"), NEXT]),
    "core.agent": _ports(
        [
            _port("in", "text", False, True),
            _port("context", "object", False, True),
            _port("audio", "audio", False, False),
            AFTER,
        ],
        [
            _port("out", "text", True, True, "text"),
            _port("data", "object", False, True, "data"),
            _port("transcript", "transcript", False, True, "transcript"),
            _port("audio", "audio", False, True, "audio"),
            NEXT,
        ],
    ),
    "core.classify": _ports(
        [_port("in", "any", True, False), AFTER],
        [_port("out", "object", True, True, "classification"), _control("otherwise"), NEXT],
    ),
    "core.humanReview": _ports(
        [_port("in", "any", False, True), AFTER],
        [
            _port("out", "object", True, True, "decision"),
            _control("approved"),
            _control("rejected"),
            _control("timedOut"),
            NEXT,
        ],
    ),
    "core.variable": _ports(
        [_port("set", "object", False, True), AFTER],
        [_port("out", "object", True, True, "vars"), NEXT],
    ),
    "core.condition": _ports(
        [_port("in", "any", False, True), AFTER],
        [_port("out", "object", True, True, "evaluation"), _control("else"), NEXT],
    ),
    "core.loop": _ports(
        [_port("in", "any", False, True), AFTER],
        [
            _port("each", "object", True, True, "item"),
            _port("done", "object", True, True, "result"),
            NEXT,
        ],
    ),
    "core.note": _ports([], []),
    "core.output": _ports([_port("in", "any", False, True), AFTER], []),
    "core.data": _ports(
        [_port("in", "object", True, True), AFTER],
        [
            _port("out", "object", True, True, "data"),
            _port("text", "text", False, True, "text"),
            NEXT,
        ],
    ),
    "core.action": _ports(
        [
            _port("in", "object", False, True),
            _port("text", "text", False, True),
            _port("transcript", "transcript", False, False),
            _port("entities", "entities", False, True),
            _port("document", "document", False, False),
            _port("context", "context<schemaRef>", False, True),
            AFTER,
        ],
        [
            _port("out", "object", True, True, "result"),
            _port("text", "text", False, True, "text"),
            _port("entities", "entities", False, True, "entities"),
            _port("verdict", "verdict", False, True, "verdict"),
            _port("document", "document", False, True, "document"),
            _port("context", "context<schemaRef>", False, True, "context"),
            NEXT,
        ],
    ),
}

#: The 17 actions behind ``core.action``: their label (the NodeIO description prefix) and their
#: own port table (``ACTION_PORTS``).
ACTION_CATALOGUE: dict[str, dict[str, Any]] = {
    "consultation.consentGate": {
        "label": "Consent gate",
        "ports": _ports([AFTER], [_control("out", True, True), NEXT]),
    },
    "consultation.bindTerminology": {
        "label": "Bind terminology",
        "ports": _ports(
            [_port("in", "entities", True, False), AFTER],
            [_port("out", "entities", True, True, "entities"), NEXT],
        ),
    },
    "consultation.phiHop": {
        "label": "Phi hop",
        "ports": _ports(
            [_port("in", "transcript", True, False), AFTER],
            [_port("out", "transcript", True, True, "text"), NEXT],
        ),
    },
    "consultation.retrieveEvidence": {
        "label": "Retrieve evidence",
        "ports": _ports(
            [_port("in", "entities", False, True), AFTER],
            [_port("out", "context<schemaRef>", True, True, "context"), NEXT],
        ),
    },
    "consultation.sensors": {
        "label": "Sensors",
        "ports": _ports(
            [
                _port("in", "document", True, False),
                _port("entities", "entities", False, True),
                AFTER,
            ],
            [
                _port("out", "verdict", True, True, "verdict"),
                _port("document", "document", True, True, "text"),
                NEXT,
            ],
        ),
    },
    "consultation.inferentialSensors": {
        "label": "Inferential sensors",
        "ports": _ports(
            [_port("in", "document", True, False), _port("verdict", "verdict", False, True), AFTER],
            [
                _port("out", "verdict", True, True, "verdict"),
                _port("document", "document", True, True, "text"),
                NEXT,
            ],
        ),
    },
    "consultation.persistDraft": {
        "label": "Persist draft",
        "ports": _ports(
            [
                _port("in", "document", True, False),
                _port("verdict", "verdict", False, True),
                _port("assurance", "verdict", False, True),
                AFTER,
            ],
            [
                _port("out", "document", True, True, "text"),
                _port("contextItemId", "text", True, True, "contextItemId"),
                NEXT,
            ],
        ),
    },
    "consultation.finalizeAssurance": {
        "label": "Finalize assurance",
        "ports": _ports(
            [
                _port("in", "document", True, False),
                _port("contextItemId", "text", False, False),
                _port("verdict", "verdict", False, True),
                _port("assurance", "verdict", False, True),
                AFTER,
            ],
            [_port("contextItemId", "text", True, True, "contextItemId"), NEXT],
        ),
    },
    "guard.phi": {
        "label": "Phi",
        "ports": _ports(
            [_port("in", "text", True, False), AFTER],
            [
                _port("out", "verdict", True, True, "verdict"),
                _port("text", "text", True, True, "text"),
                NEXT,
            ],
        ),
    },
    "guard.moderation": {
        "label": "Moderation",
        "ports": _ports(
            [_port("in", "text", True, False), AFTER],
            [_port("out", "verdict", True, True, "verdict"), NEXT],
        ),
    },
    "guard.groundedness": {
        "label": "Groundedness",
        "ports": _ports(
            [
                _port("in", "document", True, False),
                _port("transcript", "transcript", False, False),
                _port("findings", "entities", False, True),
                AFTER,
            ],
            [_port("out", "verdict", True, True, "verdict"), NEXT],
        ),
    },
    "session.timeout": {"label": "Timeout", "ports": _ports([AFTER], [NEXT])},
    "feedback.capture": {
        "label": "Capture",
        "ports": _ports([_port("in", "edits", False, True), AFTER], [NEXT]),
    },
    "livedoc.stop": {"label": "Stop", "ports": _ports([AFTER], [NEXT])},
    "harness.finalize": {"label": "Finalize", "ports": _ports([AFTER], [NEXT])},
    "summary.finalize": {
        "label": "Finalize",
        "ports": _ports([_port("in", "document", False, True), AFTER], [NEXT]),
    },
    "prompt.template_ref": {
        "label": "Template ref",
        "ports": _ports([AFTER], [_port("out", "text", True, True, "content"), NEXT]),
    },
}

EMPTY_PORTS: Ports = {"inputs": [], "outputs": []}
_NON_BRANCH_OUTPUTS = frozenset({"out", "next"})


def _as_object(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _keys_of(config: Mapping[str, Any] | None, field: str) -> list[str]:
    items = (config or {}).get(field)
    if not isinstance(items, list):
        return []
    keys = []
    for item in items:
        key = (_as_object(item) or {}).get("key")
        if isinstance(key, str) and key:
            keys.append(key)
    return keys


def branch_handles_of(node_type: str, config: Mapping[str, Any] | None) -> list[str]:
    if node_type == "core.classify":
        return [*_keys_of(config, "classes"), "otherwise"]
    if node_type == "core.condition":
        return [*_keys_of(config, "branches"), "else"]
    if node_type == "core.humanReview":
        return ["approved", "rejected", "timedOut"]
    return []


def action_delegate_of(config: Mapping[str, Any] | None) -> dict[str, Any] | None:
    key = (config or {}).get("actionKey")
    return ACTION_CATALOGUE.get(key) if isinstance(key, str) else None


def effective_ports(node_type: str, config: Mapping[str, Any] | None) -> Ports:
    if node_type == "core.action":
        delegate = action_delegate_of(config)
        if delegate is not None:
            ports: Ports = delegate["ports"]
            return ports
    base = NODE_PORTS.get(node_type, EMPTY_PORTS)
    names = {port["name"] for port in base["outputs"]}
    dynamic = [h for h in branch_handles_of(node_type, config) if h not in names]
    if not dynamic:
        return base
    return {"inputs": base["inputs"], "outputs": [*base["outputs"], *map(_control, dynamic)]}


def resolve_output_port(
    node_type: str, config: Mapping[str, Any] | None, port_name: str
) -> Port | None:
    return next(
        (p for p in effective_ports(node_type, config)["outputs"] if p["name"] == port_name), None
    )


def resolve_input_port(
    node_type: str, config: Mapping[str, Any] | None, port_name: str
) -> Port | None:
    return next(
        (p for p in effective_ports(node_type, config)["inputs"] if p["name"] == port_name), None
    )


def is_branch_handle(node_type: str, config: Mapping[str, Any] | None, port_name: str) -> bool:
    if port_name in _NON_BRANCH_OUTPUTS:
        return False
    return port_name in branch_handles_of(node_type, config)
