"""whisper.cpp per-utterance streaming adapter.

Wraps a loaded ``pywhispercpp.model.Model`` behind the streaming ASR callable
contract ``(samples, sample_rate, *, prompt) -> {text, language,
word_timestamps, segments}`` (see ``parakeet_cpp_asr.py``/``faster_whisper_asr.py``).
Per-utterance re-run, matching the parakeet.cpp integration style — whisper.cpp
has no native incremental-streaming API either.

``pywhispercpp``'s public ``Model.transcribe()`` returns SEGMENT-level
``Segment(t0, t1, text, probability)`` objects — no per-word breakdown. Real
word-level timestamps are obtained with the well-known whisper.cpp technique
of forcing near-word-sized segments (``token_timestamps=True,
split_on_word=True, max_len=1``), so this adapter gets true (not
approximated) per-word timing from a SINGLE inference pass, and then reports
one coarse ``segments`` envelope around those words.

The CLEAN (default) decode — which is what the served code-switch models run,
because word-splitting shatters Malayalam grapheme clusters — carries no word
timings, but it is NOT timestamp-free: every ``Segment``'s own ``t0``/``t1``
and ``probability`` are emitted as one ``segments`` entry each, offset into
buffer-relative time when a long utterance was split. Those clause-sized spans
are the only anchor a timestamp-driven consumer (incremental commit,
timestamp-guided trimming, per-segment confidence, diarization alignment) has
on this engine. whisper's timestamp tokens are quantised at 20 ms and known to
be loose, so treat them as ordering and trim hints, never as ground truth.

Concurrency + Metal recovery
----------------------------
A single ``pywhispercpp.model.Model`` (one ggml/whisper context) is loaded once
into the shared by-slug model cache and reused across every streaming session —
and, within a session, by both the main and the ``english_gloss`` callables.
whisper.cpp's ``whisper_full`` uses the context's single internal state and is
NOT concurrency-safe: two decodes on one context at the same time collide on
the ggml backend and, on Metal, corrupt the command buffer:

    ggml_metal_graph_compute: backend is in error state from a previous
        command buffer failure - recreate the backend to recover
    whisper_full_with_state: failed to encode

Once poisoned the backend stays in the error state for the life of the context,
so every subsequent ``whisper_full`` returns ZERO segments (empty text) — and
``pywhispercpp`` does not surface that failure (it discards ``whisper_full``'s
return code), so it is silently indistinguishable from genuine silence at the
Python level. This adapter therefore:

1. Serializes every ``transcribe`` on a per-context lock (keyed by ``model_id``,
   shared by all adapters wrapping the same ``LoadedModel``), removing the
   concurrent-command-buffer trigger.
2. Captures whisper.cpp's native log via ``whisper_log_set`` into a thread-local
   buffer, and on the poison markers recreates the context in place (mutating
   the shared ``LoadedModel.model`` so every sharer recovers) and retries once.
"""

from __future__ import annotations

import atexit
import gc
import math
import re
import threading
from typing import Any

import numpy as np
import structlog

from stt.core.exceptions import ModelInferenceError
from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat, primary_language_subtag
from stt.pipeline.language_modes import LANGUAGE_MODES_BY_ID

logger = structlog.get_logger(__name__)

# TASK-880 — the language-derived clinical-consultation priming prompt, and the
# platform flag `stt.whisperCpp.consultationPromptEnabled` that gated it, are GONE.
#
# whisper.cpp's ``initial_prompt`` is decoder prior-context, and WHAT that context
# should say is the tenant agent's decision, not a per-process boolean over two
# hardcoded lines. The agent's own ``instruction.initialPrompt`` already reaches this
# adapter as the ``prompt`` argument (``ResolvedAsrSpec.instruction`` →
# ``InferenceConfig.initial_prompt_text`` → ``compose_prompt`` with the per-utterance
# carry-forward), so setting a second context line from the same instruction would have
# applied it twice. One prompt channel, owned by the agent.
#
# TASK-938 — "one channel" names the OWNER, not the number of contributors: what
# reaches ``initial_prompt`` today is the language mode's priming prompt (when its
# switch is on) composed ahead of the agent's own instruction and the per-utterance
# carry-forward, with the resolved hotwords appended last. Each is the agent's or the
# model row's declaration; none is a per-process hardcoded line, which is what TASK-880
# actually removed.


# TASK-891 — languages whose decode may be word-split without corrupting the text.
#
# The whisper.cpp word-timestamp technique (``max_len=1, split_on_word=True``)
# cuts at TOKEN boundaries and the transcript is then rebuilt by SPACE-joining
# the trimmed pieces. That is only lossless for a Latin-script, space-delimited
# language, where whisper's byte-BPE boundaries line up with word breaks. On
# Malayalam it shatters grapheme clusters and injects spaces between a base
# character and its combining marks — measured in production as 20-35% of the
# expected characters surviving, with orphaned marks (``ൽ``, ``ും``, ``്ട്``)
# strewn through the output.
#
# An allow-list, deliberately, not a deny-list: an UNPINNED decode (auto-detect,
# or a code-switch pair, both of which reach here as ``None``) may emit any
# script the model knows, so it is refused too. A language absent from this set
# is not "unsupported" — it just decodes at sentence level and carries no word
# timings, which every downstream consumer already treats as optional.
_WORD_SPLIT_SAFE_LANGUAGES: frozenset[str] = frozenset({"en", "vi"})

# TASK-934 S-5 — how far a dropped span's end is pulled back before its ONE
# retry. The measured dead zone on the served ml-en fine-tune is ~200 ms wide
# (a buffer truncated at 4.50-4.70 s decodes to nothing; 4.40 s and 4.80 s of
# the same audio decode normally), so 250 ms clears it while staying small
# enough that the following span, which picks the trimmed tail up, is barely
# lengthened.
_EMPTY_SPAN_RETRY_PAD_S = 0.25
# RMS above which an empty decode is treated as a DROPPED span rather than as
# silence. Same floor as the streaming worker's hallucination gate.
_EMPTY_SPAN_RMS_FLOOR = 0.01


# Substrings that mark a poisoned ggml/Metal backend in whisper.cpp's native log.
_POISON_MARKERS = (
    "failed to encode",
    "error state",
    "command buffer failure",
)

# whisper.cpp logs on the thread running the native call; a thread-local buffer
# therefore isolates each decode's messages with no cross-thread bleed.
_tls = threading.local()

# One lock per whisper context (keyed by model_id) so the main and gloss
# adapters over one shared LoadedModel serialize against each other.
_model_locks_guard = threading.Lock()
_model_locks: dict[str, threading.Lock] = {}

# Poison recovery runs with the DECODE lock released (reloading a GGUF is seconds
# and every session sharing the weights would otherwise stall on it), so it needs
# its own serialization: one rebuild lock per model_id, plus a generation counter
# so a sibling that arrives while a rebuild is in flight adopts the new context
# instead of reloading the same weights again.
_rebuild_guards_guard = threading.Lock()
_rebuild_guards: dict[str, threading.Lock] = {}
_rebuild_generations: dict[str, int] = {}

_log_install_guard = threading.Lock()
_log_installed = False
# The ``_pywhispercpp`` extension module the sink is currently registered with,
# so shutdown can hand the callback back to exactly that module (see
# ``_uninstall_log_capture``). ``None`` until a registration succeeds.
_log_module: Any = None


def _dispatch_log(level: int, text: str) -> None:
    """whisper.cpp log sink (registered process-wide via ``whisper_log_set``).

    Appends to the active thread-local capture buffer when a decode is in
    flight; otherwise routes only the poison markers to the logger (dropping
    the verbose per-init ggml chatter that would otherwise flood stderr).
    """
    buffer = getattr(_tls, "buffer", None)
    if buffer is not None:
        buffer.append(text)
        return
    if any(marker in text for marker in _POISON_MARKERS):
        logger.warning("whisper.cpp native log", message=text.strip())


def _uninstall_log_capture() -> None:
    """Hand the log sink back to whisper.cpp's default logger at interpreter exit.

    ``whisper_log_set`` parks the Python callable in a pybind11 static inside
    ``_pywhispercpp``. That static outlives ``Py_Finalize``: its C++ destructor
    runs from ``exit()``'s ``__cxa_finalize_ranges``, by which point there is no
    thread state, so the ``Py_DECREF`` of ``_dispatch_log`` lands in
    ``dict_dealloc`` → ``_Py_FatalError_TstateNULL`` and the process dies with
    ``Abort trap: 6`` — after a fully green test run (exit 134). Dropping the
    reference from an ``atexit`` hook releases it while the interpreter is still
    alive, so the static holds nothing Python by the time it is destroyed.

    Shutdown-only: no decode can be in flight, so this cannot affect
    transcription behaviour. Best-effort — a failure here must never mask the
    process exit status.
    """
    module = _log_module
    if module is None:
        return
    try:
        module.whisper_log_set(None)
    except Exception:  # noqa: BLE001 — teardown must not raise at exit
        pass


def _ensure_log_capture_installed() -> None:
    global _log_installed, _log_module
    if _log_installed:
        return
    with _log_install_guard:
        if _log_installed:
            return
        try:
            import _pywhispercpp as pw

            pw.whisper_log_set(_dispatch_log)
            _log_module = pw
            # Release the callback BEFORE the interpreter finalizes; see
            # ``_uninstall_log_capture``.
            atexit.register(_uninstall_log_capture)
        except Exception as exc:  # noqa: BLE001 — capture is best-effort
            # Without the callback we lose poison auto-recovery, but the lock
            # (the primary fix) still prevents the corruption in the first place.
            logger.warning(
                "whisper.cpp log capture unavailable; Metal poison " "auto-recovery disabled",
                error=str(exc),
            )
        _log_installed = True


def _get_model_lock(model_id: str) -> threading.Lock:
    with _model_locks_guard:
        lock = _model_locks.get(model_id)
        if lock is None:
            lock = threading.Lock()
            _model_locks[model_id] = lock
        return lock


def _get_rebuild_guard(model_id: str) -> threading.Lock:
    with _rebuild_guards_guard:
        guard = _rebuild_guards.get(model_id)
        if guard is None:
            guard = threading.Lock()
            _rebuild_guards[model_id] = guard
        return guard


def _rebuild_generation(model_id: str) -> int:
    with _rebuild_guards_guard:
        return _rebuild_generations.get(model_id, 0)


def _bump_rebuild_generation(model_id: str) -> None:
    with _rebuild_guards_guard:
        _rebuild_generations[model_id] = _rebuild_generations.get(model_id, 0) + 1


def _construct_whisper_model(
    model_path: str,
    num_threads: int | None,
    use_gpu: bool,
    context_params: dict[str, Any] | None = None,
) -> Any:
    """Instantiate a fresh ``pywhispercpp.model.Model`` (a new ggml/Metal
    backend). Isolated for recovery + test seams.

    ``context_params`` carries whatever the MODEL ROW declared about the context
    (``flash_attn`` today) alongside the ``use_gpu`` this runtime derives from the
    row's device. It is merged, not replaced, and is passed by the caller ONLY
    when the row declared something: an absent runtime block means "no opinion",
    so whisper.cpp's own ``whisper_context_default_params()`` stands rather than a
    value this file invented.
    """
    from pywhispercpp.model import Model

    resolved_context: dict[str, Any] = {"use_gpu": use_gpu}
    if context_params:
        resolved_context.update(context_params)
        resolved_context["use_gpu"] = use_gpu
    kwargs: dict[str, Any] = {
        "model": model_path,
        "context_params": resolved_context,
        "print_progress": False,
        "print_realtime": False,
    }
    if num_threads is not None:
        kwargs["n_threads"] = num_threads
    return Model(**kwargs)


def _is_poisoned(logs: list[str]) -> bool:
    return any(any(marker in line for marker in _POISON_MARKERS) for line in logs)


# Greedy decoding (no temperature fallback) can degenerate into a repetition loop
# on a hard chunk (e.g. "അത് അത് അത് …" repeated dozens of times). A run of the
# SAME token longer than this many times is collapsed to a single occurrence — a
# loop guard that leaves genuine short repetitions ("no no no") untouched.
_REPEAT_RUN_LIMIT = 3
_EDGE_PUNCT_RE = re.compile(r"^[\W_]+|[\W_]+$", re.UNICODE)


def _norm_token(token: str) -> str:
    return _EDGE_PUNCT_RE.sub("", token.lower())


# Character-level degenerate loop: a short unit (1-12 chars) repeated 4+ times
# back-to-back — catches no-space scripts (Malayalam "ക്രക്രക്രക്ര…") that the
# whitespace-token guard below cannot see. Non-greedy unit, collapsed to one.
_CHAR_LOOP_RE = re.compile(r"(.{1,12}?)\1{3,}", re.UNICODE)


# Longest PHRASE (in tokens) checked for a back-to-back repetition loop. Greedy
# decoding loops on multi-word phrases too — e.g.
# "ചെയ്യുന്നതിന് നമുക്ക് protein ചെയ്യുന്നതിന് നമുക്ക് protein …" — which neither
# the single-token run guard nor the short-character guard can see.
_MAX_PHRASE_TOKENS = 8


def _collapse_phrase_loops(tokens: list[str]) -> list[str]:
    """Collapse a phrase (2..``_MAX_PHRASE_TOKENS`` tokens) repeated back-to-back
    to a single occurrence. Longest phrase wins, so a 3-token loop is not
    mis-collapsed as three 1-token ones. Single-token runs are left to the
    run-limit guard (natural speech repeats single words; it rarely repeats a
    whole multi-word phrase verbatim, so 2 consecutive copies signal a loop)."""
    norm = [_norm_token(t) for t in tokens]
    out: list[str] = []
    i = 0
    n = len(tokens)
    while i < n:
        collapsed = False
        # Longest phrase first — a 3-gram loop must not be read as 1-gram loops.
        for size in range(min(_MAX_PHRASE_TOKENS, (n - i) // 2), 1, -1):
            unit = norm[i : i + size]
            if not any(unit):  # all-punctuation unit — not a real phrase
                continue
            reps = 1
            while norm[i + reps * size : i + (reps + 1) * size] == unit:
                reps += 1
            if reps >= 2:
                out.extend(tokens[i : i + size])  # keep ONE occurrence
                i += reps * size
                collapsed = True
                break
        if not collapsed:
            out.append(tokens[i])
            i += 1
    return out


def _collapse_repeats(text: str) -> str:
    """Collapse degenerate greedy-decode repetition loops to a single occurrence.

    Three passes: (1) a whitespace-token run of >``_REPEAT_RUN_LIMIT`` identical
    tokens ("അത് അത് അത് …"); (2) a repeated multi-token PHRASE
    ("… നമുക്ക് protein … നമുക്ക് protein …"); (3) a repeated short CHARACTER unit
    for non-space-delimited scripts ("ക്രക്രക്ര…"). Genuine short repetitions
    ("no no no") survive.
    """
    tokens = text.split()
    if len(tokens) > _REPEAT_RUN_LIMIT:
        out: list[str] = []
        i = 0
        while i < len(tokens):
            j = i
            key = _norm_token(tokens[i])
            while j < len(tokens) and _norm_token(tokens[j]) == key:
                j += 1
            if key and (j - i) > _REPEAT_RUN_LIMIT:
                out.append(tokens[i])  # collapse the loop to one occurrence
            else:
                out.extend(tokens[i:j])
            i = j
        tokens = out
    if len(tokens) >= 4:
        tokens = _collapse_phrase_loops(tokens)
    return _CHAR_LOOP_RE.sub(r"\1", " ".join(tokens))


# Whisper often prepends a stray punctuation token (a leading "," or ".") to a
# segment; strip leading/trailing standalone punctuation so it doesn't surface in
# the transcript. Script letters are never touched.
_EDGE_JUNK_RE = re.compile(r"^[\s,.।;:!?\-–—]+|[\s,.।;:\-–—]+$", re.UNICODE)


def _polish(text: str) -> str:
    """Final cleanup: drop U+FFFD, repetition loop-guard, strip edge punctuation.

    U+FFFD (``�``) appears when whisper.cpp splits a multi-byte character across
    two segments — pywhispercpp decodes each segment independently with
    ``errors="replace"``, so the character is already unrecoverable by the time it
    reaches us. Dropping the marker is the only correct handling: it is never
    meaningful text.
    """
    cleaned = text.replace("�", "")
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    return _EDGE_JUNK_RE.sub("", _collapse_repeats(cleaned)).strip()


# ---------------------------------------------------------------------------
# Decode parameters
# ---------------------------------------------------------------------------
#
# pywhispercpp's ``_set_params`` is a bare ``setattr`` loop over a params object
# that PERSISTS across calls — its own docstring says "any overrides applied here
# remain active for future calls" (``model.py:199``) — and this adapter's whisper
# context is SHARED with the batch and english-gloss adapters. An omitted kwarg
# therefore does not mean "the library default": it means "whatever a sibling set
# last".
#
# ``_NEUTRAL_DECODE_PARAMS`` is what this adapter decodes at when NOBODY has
# spoken, passed explicitly on every call so no value is ever inherited. Every
# entry is the LIBRARY's own default (``pywhispercpp/constants.py``'s
# ``PARAMS_SCHEMA``) except the ones named in
# ``_NEUTRAL_DEPARTURES_FROM_LIBRARY``, so this is not a hardcoded configuration
# surface — it is the engine default restated at the call site. A row/agent value
# always wins over it.
_NEUTRAL_DECODE_PARAMS: dict[str, Any] = {
    # Sentence-level segmentation. ``True`` is upstream's own streaming advice
    # (constants.py: "force single segment output (useful for streaming)") and is
    # offered per PASS rather than taken as an engine default.
    "single_segment": False,
    "suppress_blank": True,
    # Non-speech tokens ("[music]", "(laughter)"). Library default OFF.
    "suppress_nst": False,
    # 0 = no cap. A partial may cap itself; upstream's own streaming example ships
    # ``max_tokens = 32``, which is where a row should start rather than at an
    # invented number.
    "max_tokens": 0,
    # 0 = the FULL 1500-frame encoder context.
    #
    # Deliberately NOT truncated by default, against the first reading of QW-4.
    # whisper.cpp's own streaming example ships ``audio_ctx = 0``, and reducing it
    # below the trained encoder context is a documented cause of "endless repeating
    # of the last few tokens" (whisper.cpp Discussion #297, Issues #1855/#1951).
    # Repetition and deletion are already this pipeline's two dominant error
    # classes, so the ~2x encoder speedup is a MEASURED arm on a row
    # (``decoding.audioCtx``), never a default.
    "audio_ctx": 0,
    # whisper.cpp's OWN ``prompt_past`` carry between decodes — NOT our
    # per-utterance carry-forward, which travels inside ``initial_prompt``. Pinned
    # at the library default (True = do not carry) as a LEAK GUARD: the context is
    # shared with sibling adapters, so engine-side context carry would bleed one
    # session's decoded text into another's prompt.
    "no_context": True,
    # Token-distribution entropy gate. NOT the same quantity as OpenAI's
    # compression-ratio gate despite the shared 2.4 default — see
    # ``_UNSUPPORTED_WIRE_KNOBS``.
    "entropy_thold": 2.4,
    "logprob_thold": -1.0,
    # Settable, and the bundled engine computes the quantity it gates on (the
    # dylib exports whisper_full_get_segment_no_speech_prob), but pywhispercpp's
    # own schema annotates this entry "# not implemented" and binds NEITHER
    # getter, so we can set the threshold and never observe the probability. Held
    # at the library default until a two-decode experiment settles whether the
    # decoder consults it at all; if it does not, it belongs in
    # _UNSUPPORTED_WIRE_KNOBS rather than here.
    "no_speech_thold": 0.6,
    # Pure greedy, NO temperature fallback. whisper.cpp's default
    # ``temperature_inc`` is 0.2: it re-decodes with rising temperature when a
    # segment fails its entropy/logprob check, and on this code-switch fine-tune
    # that reliably spirals into SAMPLED GARBAGE ("eurysmbalination ...") rather
    # than recovering. Disabling the fallback keeps the deterministic greedy
    # hypothesis, measured strictly better on real ml-en clinical audio.
    "temperature": 0.0,
    "temperature_inc": 0.0,
}

#: The one key above whose neutral value deliberately differs from the library's
#: own default (``temperature_inc`` 0.2 -> 0.0). Named so the parity test can
#: assert every OTHER entry still matches ``pywhispercpp.constants.PARAMS_SCHEMA``
#: and a library rename fails a unit test instead of raising ``AttributeError``
#: inside a live session.
_NEUTRAL_DEPARTURES_FROM_LIBRARY: frozenset[str] = frozenset({"temperature_inc"})

#: Row/agent decode keys -> the whisper.cpp param they set. Keyed by the WIRE name
#: FLATTENED (lowercased, underscores dropped), so ``maxTokens`` and ``max_tokens``
#: both resolve: the wire spells camelCase and the Python spec layer spells
#: snake_case, and neither spelling should be able to silently miss.
_WIRE_TO_ENGINE_PARAM: dict[str, str] = {
    "singlesegment": "single_segment",
    "suppressblank": "suppress_blank",
    "suppressnonspeechtokens": "suppress_nst",
    "suppressnst": "suppress_nst",
    "maxtokens": "max_tokens",
    "audioctx": "audio_ctx",
    "logprobthreshold": "logprob_thold",
    "entropythreshold": "entropy_thold",
    "nospeechthreshold": "no_speech_thold",
    # TASK-994 — the ENGINE spellings too: ``spec.py`` (``_TASK985_PASS_FIELDS``) emits the
    # per-pass thresholds as ``logprob_thold`` / ``entropy_thold`` / ``no_speech_thold``, and
    # until these aliases existed every per-pass threshold was dropped with a WARN.
    "logprobthold": "logprob_thold",
    "entropythold": "entropy_thold",
    "nospeechthold": "no_speech_thold",
    "temperature": "temperature",
}

#: Coercion per engine param — a row that sends a string where an int belongs is
#: rejected with one WARN rather than ``setattr``-ed onto a native struct, where a
#: wrong type is a crash rather than an error.
_ENGINE_PARAM_TYPES: dict[str, type] = {
    "single_segment": bool,
    "suppress_blank": bool,
    "suppress_nst": bool,
    "max_tokens": int,
    "audio_ctx": int,
    "logprob_thold": float,
    "entropy_thold": float,
    "no_speech_thold": float,
    "temperature": float,
}

#: A pass block may also narrow the word-timestamp decision. NARROWING ONLY — a
#: pass may turn word timestamps OFF, never ON, because turning them on would
#: bypass the script-corruption refusal in ``__init__``.
_WIRE_WORD_TIMESTAMPS = "wordtimestamps"

#: Knobs the CONFIG SURFACE carries, the gateway resolves and the wire delivers,
#: that whisper.cpp cannot honour at all. Stamped ``unsupported:whisper.cpp`` on
#: :attr:`WhisperCppAsrAdapter.unsupported_decode_knobs` and warned ONCE per model,
#: so ``decoding.sources[key] = "agent"`` stops claiming a tier decided something
#: that never reached the decoder.
#:
#: ``compressionRatioThreshold`` is here DELIBERATELY and must never be aliased to
#: ``entropy_thold``. They share the default 2.4 and pywhispercpp's own text calls
#: entropy_thold "similar to OpenAI's compression_ratio_threshold"
#: (``constants.py:277``), but they are different quantities on different scales
#: gating in OPPOSITE directions: OpenAI's is the gzip compression ratio of the
#: decoded TEXT (reject ABOVE), whisper.cpp's is the token-distribution ENTROPY
#: (reject BELOW). Aliasing them would silently mean the opposite thing.
_UNSUPPORTED_WIRE_KNOBS: dict[str, str] = {
    "compressionRatioThreshold": (
        "whisper.cpp has no compression-ratio gate; its entropy_thold is a "
        "different quantity gating in the opposite direction, exposed separately "
        "as decoding.entropyThreshold"
    ),
    "beamSize": (
        "the sampling strategy is frozen when the whisper context is constructed "
        "(pywhispercpp model.py:163-165); a greedy context cannot beam-search, and "
        "beam would need a SECOND context over the same weights"
    ),
    "noRepeatNgramSize": (
        "whisper_full_params carries no n-gram-block or repetition-penalty field; "
        "the loop guard on this engine is the post-hoc collapse in _polish"
    ),
    "conditionOnPrevTokens": (
        "whisper.cpp's only context switch is no_context, which governs the "
        "ENGINE's own prompt_past on a context shared with the batch and gloss "
        "adapters — enabling it would leak one session's decoded text into "
        "another's prompt. Our carry-forward travels in initial_prompt instead"
    ),
}

#: The value stamped for every key above. Same shape as ``decoding.sources``'s
#: tier names ("agent" / "model"), so a caller can merge the two maps and read one
#: answer per knob.
UNSUPPORTED_SOURCE = "unsupported:whisper.cpp"

#: One WARN per (model_slug, topic) for the life of the process. A per-SESSION
#: warning for a refusal the configuration itself chose is noise that buries the
#: lines that matter.
_warned_once: set[tuple[str, str]] = set()
_warned_once_guard = threading.Lock()


def _warn_once(key: tuple[str, str]) -> bool:
    """True the FIRST time *key* is seen in this process."""
    with _warned_once_guard:
        if key in _warned_once:
            return False
        _warned_once.add(key)
        return True


def _coerce_engine_param(param: str, value: Any) -> Any:
    """Coerce *value* to the type whisper.cpp's params object expects.

    Raises ``ValueError`` when it cannot — the caller turns that into one WARN and
    drops the key, which is strictly better than ``setattr``-ing a wrong type onto
    a native struct.
    """
    want = _ENGINE_PARAM_TYPES.get(param)
    if want is bool:
        if not isinstance(value, bool):
            raise ValueError(f"{param} takes a boolean, got {type(value).__name__}")
        return value
    if want is int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{param} takes an integer, got {type(value).__name__}")
        return int(value)
    if want is float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{param} takes a number, got {type(value).__name__}")
        return float(value)
    return value


def _flatten_key(key: str) -> str:
    return key.replace("_", "").replace("-", "").lower()


class WhisperCppAsrAdapter:
    """Synchronous callable wrapping a loaded whisper.cpp (pywhispercpp) model."""

    def __init__(
        self,
        loaded_model: LoadedModel,
        inference_config: Any,
        *,
        want_word_timestamps: bool = False,
    ) -> None:
        if loaded_model.format != AiModelFormat.WHISPER_CPP:
            raise ValueError(
                "WhisperCppAsrAdapter requires a WHISPER_CPP LoadedModel, "
                f"got {loaded_model.format}"
            )
        self._loaded = loaded_model
        # Decode language. A code-switch PAIR (``"ml-en"`` / ``"vi-en"``) resolves
        # to None (auto) — measured to beat pinning the primary subtag on the
        # in-house code-switch fine-tune (pinning ``ml`` over-biases toward the
        # Malayalam script and degrades the English spans). A genuine single
        # language (``"ml"`` / ``"en"``) or a region-tagged single (``"ml-IN"`` →
        # ``"ml"``) is still pinned. Code-switch pairs are recognized from the
        # closed language-mode catalog, matching ``resolve_mode_for_engine``.
        raw_language = getattr(inference_config, "language", None)
        mode = LANGUAGE_MODES_BY_ID.get(raw_language) if raw_language else None
        if mode is not None and mode.kind == "code_switch":
            self._language = None
        else:
            self._language = primary_language_subtag(raw_language)
        # Whether this pipeline consumes per-word timestamps. When False (the
        # default / the ml-en pipeline) whisper.cpp runs a CLEAN sentence-level
        # decode and the transcript is rebuilt by native concatenation — the
        # ``max_len=1`` word-splitting is a lossy, script-corrupting hack we only
        # incur when word timings are actually needed.
        #
        # TASK-891 — and only when the decode CANNOT corrupt the script. The
        # request is honoured for a pinned space-delimited language and REFUSED
        # otherwise: an intact transcript outranks optional word timings, and the
        # refusal is what stops a `wordTimestamps: true` agent on a code-switch
        # model from shredding its own output. Kept as two attributes so the
        # downgrade is diagnosable rather than invisible.
        self._word_timestamps_requested = want_word_timestamps
        self._want_word_timestamps = want_word_timestamps and (
            self._language in _WORD_SPLIT_SAFE_LANGUAGES
        )
        if want_word_timestamps and not self._want_word_timestamps:
            # INFO, once per (model, decode language) for the life of the process.
            # The refusal is the CONFIGURATION's own consequence — the ml-en agent
            # seed asks for word timestamps on a model whose script the word-split
            # corrupts — so it is a standing property of that pairing, not an
            # event. At WARNING once per SESSION it fired on every session and
            # diluted the warnings that do report something new.
            if _warn_once((loaded_model.model_slug, f"word-timestamps-refused:{self._language}")):
                logger.info(
                    "Word timestamps requested but refused — the decode may emit a "
                    "script that word-splitting corrupts; falling back to a clean "
                    "sentence-level decode with no word timings",
                    model_slug=loaded_model.model_slug,
                    language=self._language,
                )
        # Max audio length per decode — longer utterances are split at silence
        # troughs (the ml-en fine-tune truncates on long audio; VAD does not segment
        # continuous clinical speech). 0 disables the guard.
        #
        # TASK-880 — this is the MODEL's window
        # (``ResolvedAsrSpec.models.asr.metadata.maxDecodeWindowSec`` →
        # ``InferenceConfig.max_decode_window_sec``), not the platform key
        # ``stt.whisperCpp.maxAudioSeconds`` it replaces. That key applied one number
        # to every whisper.cpp row on the box, including rows with a 30s context that
        # never needed splitting; a fallback chain now decodes on its own window.
        self._max_audio_seconds: float = float(
            getattr(inference_config, "max_decode_window_sec", 0.0) or 0.0
        )
        # Shared per-context lock — the main and english-gloss adapters over one
        # cached LoadedModel MUST serialize (same underlying whisper context).
        # TASK-946 (OD-1) — the hotword append is now PER MODEL, which is what TASK-937
        # R-4 asked for. whisper.cpp has no hotword API, so the only way to bias it
        # toward a term is to list the terms in the ``initial_prompt``; on the seeded
        # ml-en fine-tune that append is also what destroys the decode. Measured offline
        # on the owner's recording (7 s spans, ``language=en``, temperature 0): no prompt
        # → 100 % Latin; the agent prompt alone → 100 %; the terms alone → 80 % with
        # "carcinoid" looping 30×; priming prompt + agent prompt + terms (what production
        # ran after TASK-938) → **2 %**. TASK-935 had already removed this exact append
        # for this exact failure.
        #
        # So the ENGINE DEFAULT is OFF and a row opts in:
        # ``AiModel._metadata.asr.decoding.hotwordsInPrompt`` → ``decoding.hotwordsInPrompt``
        # → ``InferenceConfig.hotwords_in_prompt``. Absent, ``None`` and ``False`` all
        # leave the prompt exactly as the caller composed it.
        #
        # The TERMS are kept either way. They are still the lexicon correction stage's
        # vocabulary (TASK-935 OD-5 a), so turning the prompt off costs decode BIAS and
        # never the clinical vocabulary itself.
        raw_hotwords = getattr(inference_config, "hotwords", None) or []
        self._hotwords: list[str] = [
            w.strip() for w in raw_hotwords if isinstance(w, str) and w.strip()
        ]
        self._hotwords_in_prompt: bool = bool(
            getattr(inference_config, "hotwords_in_prompt", False)
        )
        #: Knobs the caller configured that this engine cannot honour, wire name ->
        #: :data:`UNSUPPORTED_SOURCE`. PUBLIC: the session layer merges it into
        #: ``decoding.sources`` so provenance names the engine's refusal instead of
        #: naming a tier that decided nothing.
        self.unsupported_decode_knobs: dict[str, str] = {}
        #: The row/agent flat decode block, already translated to engine params.
        self._decode_base: dict[str, Any] = {}
        #: Per-pass narrowings of the flat block, keyed "partial" / "final".
        self._decode_by_pass: dict[str, dict[str, Any]] = {}
        #: Passes that asked for word timestamps to be OFF (narrowing only).
        self._pass_word_timestamp_veto: frozenset[str] = frozenset()
        self._resolve_decode_config(inference_config)
        self._lock = _get_model_lock(loaded_model.model_id)
        _ensure_log_capture_installed()

    # -- configuration ------------------------------------------------------

    def _resolve_decode_config(self, inference_config: Any) -> None:
        """Fold the resolved decode block into engine params, once, at bind time.

        Precedence, and it is the only one: **pass block -> flat block -> the
        neutral value**. Absent means "no opinion", never "off" — so a row that
        recommends one knob does not imply an opinion on the rest, and every knob
        nobody named decodes at :data:`_NEUTRAL_DECODE_PARAMS`.

        Knobs the config carries that whisper.cpp has no equivalent for are
        recorded on :attr:`unsupported_decode_knobs` and warned once, rather than
        being dropped silently or aliased onto a param that means something else.
        """
        base: dict[str, Any] = {}

        # The flat knobs that DO reach this engine, read off InferenceConfig where
        # the gateway already folded agent -> model row -> absent. `getattr` with a
        # default throughout: a config predating a field (the deprecated pipeline
        # path, or a test double) must decode at the neutral, not explode.
        for attr, param in (
            ("logprob_threshold", "logprob_thold"),
            ("entropy_threshold", "entropy_thold"),
            ("no_speech_threshold", "no_speech_thold"),
        ):
            value = getattr(inference_config, attr, None)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                base[param] = float(value)

        # `InferenceConfig.temperature` is a LADDER (list) because faster-whisper
        # takes one. whisper.cpp takes a scalar plus `temperature_inc`, so only the
        # BASE rung is expressible — and `temperature_inc` stays 0.0 by the measured
        # decision recorded on `_NEUTRAL_DECODE_PARAMS`. Taking element 0 reproduces
        # today's hardcoded 0.0 for the dataclass default ladder and honours a row
        # that declares a single scalar (`spec.py` sends `[value]`).
        temperature = getattr(inference_config, "temperature", None)
        if isinstance(temperature, (list, tuple)) and temperature:
            temperature = temperature[0]
        if isinstance(temperature, (int, float)) and not isinstance(temperature, bool):
            base["temperature"] = float(temperature)

        # TASK-994 — the ROW-level decode block. ``spec.py`` folds
        # ``AiModel._metadata.asr.decoding.{singleSegment, suppressBlank,
        # suppressNonSpeechTokens, maxTokens, audioCtx}`` into
        # ``InferenceConfig.decode_base`` (engine spelling); it applies to BOTH passes
        # and sits between the flat fields and the per-pass blocks. Before this read
        # existed, a row's recommendation was inert unless repeated inside
        # ``partial`` / ``final``.
        base_veto = False
        raw_base = getattr(inference_config, "decode_base", None)
        if isinstance(raw_base, dict) and raw_base:
            resolved_base, base_veto = self._translate_decode_block(raw_base, "base")
            base.update(resolved_base)

        self._decode_base = base

        # Per-pass blocks. `decode_partial` / `decode_final` carry
        # `AiModel._metadata.asr.decoding.{partial,final}` verbatim; absent (every
        # config predating them) leaves the flat block standing alone.
        by_pass: dict[str, dict[str, Any]] = {}
        veto: set[str] = {"partial", "final"} if base_veto else set()
        for pass_kind, attr in (("partial", "decode_partial"), ("final", "decode_final")):
            raw = getattr(inference_config, attr, None)
            if not isinstance(raw, dict) or not raw:
                continue
            resolved, vetoes_word_timestamps = self._translate_decode_block(raw, pass_kind)
            if resolved:
                by_pass[pass_kind] = resolved
            if vetoes_word_timestamps:
                veto.add(pass_kind)
        self._decode_by_pass = by_pass
        self._pass_word_timestamp_veto = frozenset(veto)

        self._record_unsupported_knobs(inference_config)

    def _translate_decode_block(
        self, raw: dict[str, Any], where: str
    ) -> tuple[dict[str, Any], bool]:
        """Translate one wire decode block to engine params.

        Returns ``(params, vetoes_word_timestamps)``. Unknown and unusable keys are
        DROPPED with one WARN naming them — never forwarded, because every kwarg
        this adapter passes is ``setattr``-ed straight onto a native params struct.
        """
        params: dict[str, Any] = {}
        veto = False
        rejected: list[str] = []
        for key, value in raw.items():
            if value is None:  # "no opinion", exactly like an absent key
                continue
            flat = _flatten_key(str(key))
            if flat == _WIRE_WORD_TIMESTAMPS:
                # NARROWING ONLY. `True` here cannot re-enable a mode `__init__`
                # refused for script safety, so it is accepted and ignored.
                veto = value is False
                continue
            param = _WIRE_TO_ENGINE_PARAM.get(flat)
            if param is None:
                rejected.append(str(key))
                continue
            try:
                params[param] = _coerce_engine_param(param, value)
            except ValueError as exc:
                rejected.append(f"{key} ({exc})")
        if rejected and _warn_once((self._loaded.model_slug, f"decode-block-rejected:{where}")):
            logger.warning(
                "whisper.cpp decode block carries keys this engine cannot use; "
                "they were dropped",
                model_slug=self._loaded.model_slug,
                decode_pass=where,
                rejected=sorted(rejected),
            )
        return params, veto

    def _record_unsupported_knobs(self, inference_config: Any) -> None:
        """Name every configured knob whisper.cpp cannot honour, once per model."""
        unsupported: dict[str, str] = {}

        beam_size = getattr(inference_config, "beam_size", None)
        if isinstance(beam_size, int) and not isinstance(beam_size, bool) and beam_size > 1:
            unsupported["beamSize"] = UNSUPPORTED_SOURCE

        crt = getattr(inference_config, "compression_ratio_threshold", None)
        if isinstance(crt, (int, float)) and not isinstance(crt, bool):
            unsupported["compressionRatioThreshold"] = UNSUPPORTED_SOURCE

        nrns = getattr(inference_config, "no_repeat_ngram_size", None)
        if isinstance(nrns, int) and not isinstance(nrns, bool) and nrns > 0:
            unsupported["noRepeatNgramSize"] = UNSUPPORTED_SOURCE

        if getattr(inference_config, "condition_on_prev_tokens", False) is True:
            unsupported["conditionOnPrevTokens"] = UNSUPPORTED_SOURCE

        self.unsupported_decode_knobs = unsupported
        if not unsupported:
            return
        if _warn_once((self._loaded.model_slug, "unsupported-decode-knobs")):
            logger.warning(
                "decode knobs configured for this model cannot reach whisper.cpp; "
                "they are reported as unsupported rather than silently dropped",
                model_slug=self._loaded.model_slug,
                stamped_source=UNSUPPORTED_SOURCE,
                unsupported=sorted(unsupported),
                reasons={key: _UNSUPPORTED_WIRE_KNOBS[key] for key in sorted(unsupported)},
            )

    def _decode_kwargs(self, pass_kind: str | None) -> dict[str, Any]:
        """Every honoured decode param, explicitly, for THIS pass.

        Absent config is the neutral value, never an omitted key: pywhispercpp's
        params object persists across calls on a context this adapter shares with
        the batch and gloss adapters, so an omitted kwarg inherits a sibling's
        value rather than the library's default.
        """
        kwargs = dict(_NEUTRAL_DECODE_PARAMS)
        kwargs.update(self._decode_base)
        if pass_kind:
            kwargs.update(self._decode_by_pass.get(pass_kind, {}))
        return kwargs

    def _word_timestamps_for(self, pass_kind: str | None) -> bool:
        """Whether THIS pass decodes in word-split mode.

        One function because the decode kwargs and the result reconstruction must
        never disagree: a decode that ran `max_len=1` and a result built as if it
        had not is a space-joined, grapheme-shattered transcript.

        A pass block may only NARROW: ``wordTimestamps: false`` turns the mode off
        for that pass, and ``true`` cannot turn it back on, because ``__init__``
        may have refused it for script safety and a row must not be able to route
        around that refusal.
        """
        return self._want_word_timestamps and pass_kind not in self._pass_word_timestamp_veto

    def __call__(
        self,
        samples: np.ndarray,
        sample_rate: int,
        *,
        prompt: str | None = None,
        max_decode_window_sec: float | None = None,
        pass_kind: str | None = None,
    ) -> dict[str, Any]:
        """Decode one buffer.

        ``pass_kind`` names which streaming pass this decode serves — ``"partial"``
        or ``"final"`` — and selects the matching per-pass narrowing of the decode
        block (``AiModel._metadata.asr.decoding.{partial,final}``). ``None`` (the
        default, and every caller that predates the parameter) decodes at the flat
        block alone, unchanged. Declared as a NAMED parameter rather than absorbed
        by ``**kwargs`` so the caller's signature probe can tell "this engine takes
        a pass kind" from "this engine does not".

        TASK-934 — ``max_decode_window_sec`` is a PER-CALL window and it outranks
        the one this adapter was constructed with. Two things need that:

        * the partial window and the decode window are independent knobs
          (``partialWindowSec`` 15 s against ``maxDecodeWindowSec`` 7 s on the
          measured ml-en profile), so a 15 s partial must decode in ONE pass
          instead of being re-split into the short window the measurement
          rejected; and
        * G-6 — the window then travels with the CALL rather than with the
          adapter instance, so a model-row edit reaches a new session without a
          process restart, even where the loaded weights are shared.

        ``None`` keeps the constructed window (unchanged behaviour); ``0``
        disables the guard for this call.
        """
        audio = np.asarray(samples, dtype=np.float32)

        window = (
            self._max_audio_seconds
            if max_decode_window_sec is None
            else float(max_decode_window_sec)
        )
        spans = self._split_spans(audio, sample_rate, window)
        with self._lock:
            sub_results, spans = self._decode_spans_locked(
                audio, spans, sample_rate, prompt, pass_kind
            )
        return self._merge_results(sub_results, spans, audio, sample_rate)

    def _decode_spans_locked(
        self,
        audio: np.ndarray,
        spans: list[tuple[int, int]],
        sample_rate: int,
        prompt: str | None,
        pass_kind: str | None = None,
    ) -> tuple[list[dict[str, Any]], list[tuple[int, int]]]:
        """Decode each span, retrying once a SPAN THE ENGINE DROPPED.

        TASK-934 S-5 — measured offline on the served q8_0 ml-en fine-tune with
        `discharge_summary_01.wav`: the clip decodes fully as one buffer (WER
        0.081) and loses its first 9.7 s at a 7 s decode window (WER 0.468, the
        14 deletions seen live). The cause is not variance, not the prompt and
        not any post-filter — `_split_spans` snaps the first cut to the quietest
        frame at 4.625 s, and this fine-tune returns an EMPTY decode for a
        buffer truncated anywhere in 4.50-4.70 s (3 of 3 repeats; 4.40 s and
        4.80 s of the same audio decode normally). The engine drops the whole
        SPAN, so nothing downstream can recover it — the words never exist.

        So a span that carries speech and decodes to nothing is decoded once
        more with its end pulled back by ``_EMPTY_SPAN_RETRY_PAD_S``, which is
        wider than the measured dead zone. The FOLLOWING span's start moves to
        the same boundary, so the partition stays exact: no audio is skipped and
        none is decoded twice. Not applied to the last span (no following span
        to carry the trimmed tail — that would lose audio outright) nor to a
        span that is genuinely silent, which is entitled to decode to nothing.
        """
        pad = int(_EMPTY_SPAN_RETRY_PAD_S * sample_rate)
        results: list[dict[str, Any]] = []
        decoded: list[tuple[int, int]] = []
        start = spans[0][0] if spans else 0
        for index, (_, end) in enumerate(spans):
            segments = self._decode_recover_locked(audio[start:end], prompt, pass_kind)
            result = self._build_result(segments, audio[start:end], sample_rate, pass_kind)
            retriable = index < len(spans) - 1 and (end - pad) > start
            if not result["text"] and retriable and self._carries_speech(audio[start:end]):
                logger.warning(
                    "whisper.cpp returned nothing for a span carrying speech; "
                    "retrying with a pulled-back boundary",
                    model_slug=self._loaded.model_slug,
                    span_start_s=round(start / sample_rate, 3),
                    span_end_s=round(end / sample_rate, 3),
                )
                retry_end = end - pad
                retry_segments = self._decode_recover_locked(
                    audio[start:retry_end], prompt, pass_kind
                )
                retry_result = self._build_result(
                    retry_segments, audio[start:retry_end], sample_rate, pass_kind
                )
                if retry_result["text"]:
                    result, end = retry_result, retry_end
            results.append(result)
            decoded.append((start, end))
            start = end
        return results, decoded

    @staticmethod
    def _carries_speech(audio: np.ndarray) -> bool:
        """Whether a span has enough energy that an empty decode is suspicious."""
        if audio.size == 0:
            return False
        return float(np.sqrt(np.mean(audio.astype(np.float32) ** 2))) >= _EMPTY_SPAN_RMS_FLOOR

    def _decode_recover_locked(
        self, audio: np.ndarray, prompt: str | None, pass_kind: str | None = None
    ) -> list[Any]:
        """Decode one buffer with Metal-poison auto-recovery. Lock must be held.

        An ENGINE FAILURE raises :class:`ModelInferenceError` rather than returning
        an empty segment list. pywhispercpp discards ``whisper_full``'s return code,
        so a poisoned backend is indistinguishable at the Python level from genuine
        silence — and returning ``[]`` made it look like a quiet clinician. That is
        the whole of the fault: ``EngineSwitchController`` arms on ``ModelError``
        and on nothing else, so while this path answered ``[]`` the declared
        fallback chain was unreachable for the PRIMARY engine class, and the
        session stayed silently empty on exactly the failure auto-switch exists for.

        The distinction that must survive: an empty decode with NO poison marker is
        a genuinely silent utterance and still returns ``[]``. Only a decode whose
        native log carries a poison marker — the backend telling us it failed — is
        treated as a failure, and even then only after the ONE in-place recovery
        below has been tried.
        """
        segments, logs = self._decode_capturing(audio, prompt, pass_kind)
        if not _is_poisoned(logs):
            return segments

        logger.warning(
            "whisper.cpp Metal backend poisoned; recreating context",
            model_slug=self._loaded.model_slug,
        )
        if not self._recover_context():
            raise ModelInferenceError(
                "whisper.cpp backend is in an unrecoverable error state and the "
                f"context could not be recreated (model '{self._loaded.model_slug}')"
            )
        segments, logs = self._decode_capturing(audio, prompt, pass_kind)
        if _is_poisoned(logs):
            raise ModelInferenceError(
                "whisper.cpp is still failing after the backend was recreated "
                f"(model '{self._loaded.model_slug}')"
            )
        return segments

    def _recover_context(self) -> bool:
        """Recreate the shared whisper context with the DECODE LOCK RELEASED.

        Reloading the GGUF is seconds of mmap + backend init. Doing it under the
        per-context decode lock stalls every session sharing these weights for that
        whole time — on the one engine whose failure mode is already a stall. The
        lock is therefore dropped around the construction and re-taken before
        returning, so the caller's ``with self._lock`` still owns it on both sides.

        Releasing it is safe because a decode running on the OLD context holds its
        own local reference to that model object (``_decode_capturing`` binds it
        before calling), so the swap below rebinds a name and never frees a context
        a native call is inside. A sibling that decodes on the poisoned context
        while we rebuild simply sees the poison markers itself and lands on the
        generation check in :meth:`_rebuild_shared`.

        Must be called with ``self._lock`` HELD; it is held again on return.
        """
        self._lock.release()
        try:
            return self._rebuild_shared()
        finally:
            self._lock.acquire()

    def _split_spans(
        self, audio: np.ndarray, sample_rate: int, max_audio_seconds: float
    ) -> list[tuple[int, int]]:
        """Split *audio* into ``[start, end)`` sample spans no longer than
        ``max_audio_seconds``, cutting at the quietest point (a word gap / silence
        trough) near each target boundary. Returns a single whole-buffer span when
        the guard is disabled or the audio already fits."""
        n = len(audio)
        if max_audio_seconds <= 0 or sample_rate <= 0:
            return [(0, n)]
        max_len = int(max_audio_seconds * sample_rate)
        if n <= max_len:
            return [(0, n)]
        # Greedy forward: from the current position, cut at the DEEPEST silence
        # (global RMS minimum = the clearest pause) within the allowed window
        # ``[pos + min_len, pos + max_len]``. Snapping to a real pause avoids
        # mid-word cuts that make a chunk mis-decode. ``min_len`` keeps chunks from
        # becoming tiny.
        min_len = max(1, int(max_len * 0.5))
        spans: list[tuple[int, int]] = []
        i = 0
        while i < n:
            if n - i <= max_len:
                spans.append((i, n))
                break
            lo = i + min_len
            hi = i + max_len
            cut = self._quietest_in_range(audio, lo, hi)
            if cut <= i:  # safety — never stall
                cut = hi
            spans.append((i, cut))
            i = cut
        return spans or [(0, n)]

    @staticmethod
    def _quietest_in_range(audio: np.ndarray, lo: int, hi: int) -> int:
        """Sample index of the lowest-RMS 30 ms frame in ``[lo, hi)`` — the
        clearest silence trough / word gap to cut at."""
        n = len(audio)
        lo = max(1, min(lo, n - 1))
        hi = max(lo + 1, min(hi, n))
        win = 480  # 30 ms @ 16 kHz
        step = win // 2 or 1
        best_i, best_e = hi, float("inf")
        for j in range(lo, hi, step):
            frame = audio[j : j + win]
            e = float(np.mean(frame * frame)) if frame.size else float("inf")
            if e < best_e:
                best_e, best_i = e, j
        return best_i

    def _merge_results(
        self,
        sub_results: list[dict[str, Any]],
        spans: list[tuple[int, int]],
        audio: np.ndarray,
        sample_rate: int,
    ) -> dict[str, Any]:
        """Stitch per-chunk results: join texts, offset+concatenate word timestamps
        AND segment spans, apply the repetition loop-guard, and emit one
        utterance-level result.

        Each span's segment times are BUFFER-relative (whisper.cpp times each
        decode from zero), so merging shifts them by that span's own start. The
        result's ``segments`` therefore reads as one continuous, ordered timeline
        over the buffer this call was given, whatever the split guard did to it.

        ``text`` stays the polished join of the per-span texts: it is the
        authoritative transcript and is byte-identical to what this method
        produced before segment spans existed. Per-segment ``text`` is polished
        individually, so the concatenation of the segment texts is NOT guaranteed
        to equal ``text`` — a loop spanning a segment boundary collapses once in
        the whole-utterance view and not at all in the per-segment one.
        """
        if len(sub_results) == 1:
            sub_results[0]["text"] = _polish(sub_results[0]["text"])
            return sub_results[0]

        text_parts: list[str] = []
        word_timestamps: list[dict[str, Any]] = []
        segments: list[dict[str, Any]] = []
        for (start_sample, _end), res in zip(spans, sub_results, strict=True):
            if res["text"]:
                text_parts.append(res["text"])
            offset = start_sample / float(sample_rate) if sample_rate else 0.0
            for w in res["word_timestamps"]:
                word_timestamps.append(
                    {
                        **w,
                        "start": round(w["start"] + offset, 4),
                        "end": round(w["end"] + offset, 4),
                    }
                )
            for seg in res["segments"]:
                segments.append(
                    {
                        **seg,
                        "start": round(seg["start"] + offset, 4),
                        "end": round(seg["end"] + offset, 4),
                    }
                )
        text = _polish(" ".join(text_parts))
        return {
            "text": text,
            "language": self._language,
            "word_timestamps": word_timestamps,
            "segments": segments if text else [],
        }

    def _decode_capturing(
        self, audio: np.ndarray, prompt: str | None, pass_kind: str | None = None
    ) -> tuple[list[Any], list[str]]:
        """Run one decode while capturing whisper.cpp's native log for this
        thread. Must be called with ``self._lock`` held."""
        model = self._loaded.model
        # The ONE prompt channel: the agent's ``instruction.initialPrompt`` already
        # composed with the per-utterance carry-forward by the caller
        # (``compose_prompt``). ``""`` rather than ``None`` because the binding's
        # setter rejects None and the shared context persists params across calls.
        #
        # TASK-946 (OD-1) — the hotwords join the prompt ONLY when this model's row
        # opted in (``decoding.hotwordsInPrompt``). Off by default; see ``__init__``.
        parts = [(prompt or "").strip()]
        if self._hotwords_in_prompt:
            parts.append(", ".join(self._hotwords))
        effective_prompt = " ".join(part for part in parts if part)
        # Word-timestamp mode forces near-word-sized segments (``max_len=1``,
        # ``split_on_word``) so each segment carries its own (t0, t1). This is
        # only requested when the pipeline consumes word timings; otherwise a
        # clean sentence-level decode is both faster and avoids the space-joining
        # corruption of non-space-delimited scripts (Malayalam).
        #
        # Every param this engine honours is passed EXPLICITLY on every call, never
        # omitted. pywhispercpp's ``_set_params`` setattrs only the kwargs it
        # receives onto a params object that persists across calls, and the whisper
        # context is shared with the batch/gloss adapters — an omitted kwarg would
        # silently inherit whatever a sibling adapter set last (e.g. a pinned
        # ``language="en"`` or ``max_len=1``). The configurable set is
        # ``_NEUTRAL_DECODE_PARAMS`` narrowed by the row/agent block and then by
        # this pass's block; the kwargs written out below are COMPUTED — the
        # word-split trio, the decode language and the composed prompt — and are
        # therefore not overridable from a row.
        word_timestamps = self._word_timestamps_for(pass_kind)
        prev = getattr(_tls, "buffer", None)
        _tls.buffer = []
        try:
            segments = model.transcribe(
                audio,
                extract_probability=True,
                token_timestamps=word_timestamps,
                split_on_word=word_timestamps,
                max_len=1 if word_timestamps else 0,
                # ``None`` is coerced to ``""`` by the binding's setter — both
                # mean auto-detect, which is the measured, load-bearing
                # behaviour for code-switch pairs.
                language=self._language if self._language else None,
                # The setter rejects ``None`` for ``initial_prompt``; ``""`` is
                # its neutral (tokenizes to nothing).
                initial_prompt=effective_prompt,
                **self._decode_kwargs(pass_kind),
            )
        finally:
            logs = _tls.buffer
            _tls.buffer = prev
        return list(segments or []), logs

    def _rebuild_shared(self) -> bool:
        """Recreate the whisper context in place (shared ``LoadedModel.model``, so
        every adapter over it recovers). Returns ``False`` when the reload params
        are unavailable or the construction fails.

        The DECODE lock must NOT be held (see :meth:`_recover_context`); rebuilds
        serialize on their own per-model guard instead. A sibling that was waiting
        on that guard while we rebuilt sees the generation move and adopts OUR
        context rather than reloading the same weights a second time.
        """
        extra = self._loaded.extra or {}
        model_path = extra.get("model_path")
        if not model_path:
            logger.error(
                "cannot recreate whisper.cpp context — no model_path recorded",
                model_slug=self._loaded.model_slug,
            )
            return False

        model_id = self._loaded.model_id
        generation_at_entry = _rebuild_generation(model_id)
        with _get_rebuild_guard(model_id):
            if _rebuild_generation(model_id) != generation_at_entry:
                logger.info(
                    "whisper.cpp context was already recreated by a sibling decode; "
                    "adopting it",
                    model_slug=self._loaded.model_slug,
                )
                return True
            # The context params the LOADER used, replayed so the recovered
            # context is the same context — a row-level `flash_attn` applied at
            # load and silently dropped on the recovery path would mean the
            # RECOVERY path runs a configuration nobody chose. Forwarded only when
            # the row declared one, so an undeclared context keeps the library's
            # own defaults (see `_construct_whisper_model`).
            context_params = extra.get("context_params") or {}
            try:
                new_model = _construct_whisper_model(
                    model_path,
                    extra.get("num_threads"),
                    self._loaded.device != "cpu",
                    **({"context_params": context_params} if context_params else {}),
                )
            except Exception as exc:  # noqa: BLE001 — recovery must not crash the hot path
                logger.error(
                    "failed to recreate whisper.cpp context",
                    model_slug=self._loaded.model_slug,
                    error=str(exc),
                )
                return False
            old = self._loaded.model
            self._loaded.model = new_model
            _bump_rebuild_generation(model_id)
        # Outside the guard: `del` only drops OUR reference. A decode still inside
        # `whisper_full` on the old context holds its own, so refcounting keeps that
        # context alive until it returns — `gc.collect()` cannot free it underneath
        # a native call.
        del old
        gc.collect()
        return True

    @staticmethod
    def _segment_confidence(segment: Any) -> float:
        """``Segment.probability`` as a usable confidence.

        ``extract_probability=True`` makes pywhispercpp compute the geometric mean
        of the segment's token probabilities, which is interpretable as a
        probability in [0, 1]. It is ``NaN`` when the calculation did not run, and
        a missing/NaN value reads as "unknown", never as "certainly wrong" — so it
        degrades to 1.0 rather than to 0.0, which a downstream confidence gate
        would treat as a reason to drop good text.
        """
        probability = getattr(segment, "probability", None)
        if probability is None:
            return 1.0
        try:
            value = float(probability)
        except (TypeError, ValueError):
            return 1.0
        return 1.0 if math.isnan(value) else value

    def _build_result(
        self,
        segments: list[Any],
        audio: np.ndarray,
        sample_rate: int,
        pass_kind: str | None = None,
    ) -> dict[str, Any]:
        duration = len(audio) / float(sample_rate) if sample_rate else 0.0

        if self._word_timestamps_for(pass_kind):
            # Word-timestamp mode: each segment is one space-trimmed word (from
            # ``split_on_word``/``max_len=1``). Emit per-word timings AND rebuild
            # the transcript by SPACE-joining the trimmed words — the correct
            # reconstruction for this segmentation (whisper.cpp consumed the
            # boundary whitespace as the split point).
            word_timestamps: list[dict[str, Any]] = []
            for seg in segments:
                word = str(seg.text or "").strip()
                if not word:
                    continue
                word_timestamps.append(
                    {
                        "word": word,
                        # pywhispercpp t0/t1 are whisper.cpp's raw 10ms units.
                        "start": seg.t0 / 100.0,
                        "end": seg.t1 / 100.0,
                        "confidence": self._segment_confidence(seg),
                    }
                )
            text = " ".join(w["word"] for w in word_timestamps)
            # In this mode a "segment" IS a word, so the word timings are the
            # anchor and the span is the coarse envelope around them, as before.
            start = word_timestamps[0]["start"] if word_timestamps else 0.0
            end = word_timestamps[-1]["end"] if word_timestamps else duration
            out_segments = [{"text": text, "start": start, "end": end}] if text else []
        else:
            # Clean sentence-level decode: rebuild the transcript by NATIVE
            # concatenation of segment text, preserving whisper's own spacing (its
            # byte-BPE attaches a leading space to word-initial tokens). This is the
            # ONLY correct reconstruction for non-space-delimited scripts like
            # Malayalam — space-joining segments would inject spurious spaces and
            # split grapheme clusters. No per-word timings in this mode.
            text = re.sub(r"\s+", " ", "".join(str(seg.text or "") for seg in segments)).strip()
            word_timestamps = []
            # ...but whisper.cpp DID time each of those segments, and this branch
            # used to throw that away three lines before use: it emitted ONE
            # synthetic span `{text, 0.0, duration}` over the whole buffer. On the
            # served ml-en model, where word timestamps are (correctly) refused
            # because word-splitting shatters Malayalam grapheme clusters, that
            # made the result timestamp-free — and every timestamp-anchored design
            # downstream (incremental commit, timestamp-guided buffer trimming,
            # per-segment confidence gating, diarization alignment) was blocked on
            # data the engine had already returned.
            #
            # So: one entry per whisper segment, carrying its own `t0`/`t1` (raw
            # 10 ms units, hence /100) and the geometric-mean token probability
            # `extract_probability=True` already computes. The clean decode itself
            # is UNCHANGED — no `max_len=1`, no word splitting, no second pass —
            # this only stops discarding what came back. Whisper's segment
            # boundaries are clause-sized and its timestamp tokens are quantised
            # at 20 ms and known to be loose, so these are a commit ordering and a
            # trim hint, never ground truth.
            out_segments = []
            for seg in segments:
                seg_text = _polish(str(seg.text or ""))
                if not seg_text:
                    continue
                out_segments.append(
                    {
                        "text": seg_text,
                        "start": seg.t0 / 100.0,
                        "end": seg.t1 / 100.0,
                        "probability": self._segment_confidence(seg),
                    }
                )

        return {
            "text": text,
            "language": self._language,
            "word_timestamps": word_timestamps,
            "segments": out_segments if text else [],
        }
