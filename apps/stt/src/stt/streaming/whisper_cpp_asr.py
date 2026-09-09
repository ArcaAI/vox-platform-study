"""whisper.cpp per-utterance streaming adapter.

Wraps a loaded ``pywhispercpp.model.Model`` behind the streaming ASR callable
contract ``(samples, sample_rate, *, prompt) -> {text, language,
word_timestamps, segments}`` (see ``parakeet_cpp_asr.py``/``faster_whisper_asr.py``).
Per-utterance re-run, matching the parakeet.cpp integration style — whisper.cpp
has no native incremental-streaming API either.

``pywhispercpp``'s public ``Model.transcribe()`` only returns SEGMENT-level
``Segment(t0, t1, text, probability)`` objects — no per-word breakdown. Real
word-level timestamps are obtained with the well-known whisper.cpp technique
of forcing near-word-sized segments (``token_timestamps=True,
split_on_word=True, max_len=1``), so this adapter gets true (not
approximated) per-word timing from a SINGLE inference pass, then reconstructs
a single whole-utterance ``segments`` entry — the same "one coarse span"
simplification ``ParakeetCppAsrAdapter`` uses for an engine without native
sentence-level segmentation.

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


def _construct_whisper_model(model_path: str, num_threads: int | None, use_gpu: bool) -> Any:
    """Instantiate a fresh ``pywhispercpp.model.Model`` (a new ggml/Metal
    backend). Isolated for recovery + test seams."""
    from pywhispercpp.model import Model

    kwargs: dict[str, Any] = {
        "model": model_path,
        "context_params": {"use_gpu": use_gpu},
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
            logger.warning(
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
        # TASK-934 / TASK-938 — the profile's (or agent's) ``hotwords`` become decoder
        # prompt vocabulary: whisper.cpp has no hotword API, and listing the terms in the
        # prompt is the established biasing technique. Empty entries are dropped.
        #
        # TASK-935 REMOVED this after the first live run of it (the run was only possible
        # once TASK-935 fixed the per-session spec lookup) collapsed this ml-en fine-tune's
        # decode into script garbage on the discharge fixture, with SIX terms as badly as
        # twenty. It is restored by owner directive (2026-09-09) as one arm of the TASK-938
        # A/B, alongside both priming-prompt switches — a configuration that has never been
        # measured as a whole. If the garbage returns, THIS is the first knob to drop:
        # unlike the priming prompts it adds no linguistic signal, only vocabulary, and the
        # same terms already reach the lexicon correction stage after the decode.
        # TASK-937 R-4 is where this becomes a per-model ``decoding.hotwordsInPrompt``
        # switch instead of a global one.
        raw_hotwords = getattr(inference_config, "hotwords", None) or []
        self._hotwords: list[str] = [
            w.strip() for w in raw_hotwords if isinstance(w, str) and w.strip()
        ]
        self._lock = _get_model_lock(loaded_model.model_id)
        _ensure_log_capture_installed()

    def __call__(
        self,
        samples: np.ndarray,
        sample_rate: int,
        *,
        prompt: str | None = None,
        max_decode_window_sec: float | None = None,
    ) -> dict[str, Any]:
        """Decode one buffer.

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
            sub_results, spans = self._decode_spans_locked(audio, spans, sample_rate, prompt)
        return self._merge_results(sub_results, spans, audio, sample_rate)

    def _decode_spans_locked(
        self,
        audio: np.ndarray,
        spans: list[tuple[int, int]],
        sample_rate: int,
        prompt: str | None,
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
            segments = self._decode_recover_locked(audio[start:end], prompt)
            result = self._build_result(segments, audio[start:end], sample_rate)
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
                retry_segments = self._decode_recover_locked(audio[start:retry_end], prompt)
                retry_result = self._build_result(
                    retry_segments, audio[start:retry_end], sample_rate
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

    def _decode_recover_locked(self, audio: np.ndarray, prompt: str | None) -> list[Any]:
        """Decode one buffer with Metal-poison auto-recovery. Lock must be held."""
        segments, logs = self._decode_capturing(audio, prompt)
        if _is_poisoned(logs):
            logger.warning(
                "whisper.cpp Metal backend poisoned; recreating context",
                model_slug=self._loaded.model_slug,
            )
            if self._rebuild_locked():
                segments, logs = self._decode_capturing(audio, prompt)
                if _is_poisoned(logs):
                    logger.error(
                        "whisper.cpp still failing after backend recreate; "
                        "returning empty transcription",
                        model_slug=self._loaded.model_slug,
                    )
                    return []
            else:
                return []
        return segments

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
        """Stitch per-chunk results: join texts, offset+concatenate word
        timestamps, apply the repetition loop-guard, and emit one utterance-level
        result. A single span is returned as-is (fast path)."""
        if len(sub_results) == 1:
            sub_results[0]["text"] = _polish(sub_results[0]["text"])
            if sub_results[0]["segments"]:
                sub_results[0]["segments"][0]["text"] = sub_results[0]["text"]
            return sub_results[0]

        text_parts: list[str] = []
        word_timestamps: list[dict[str, Any]] = []
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
        text = _polish(" ".join(text_parts))
        duration = len(audio) / float(sample_rate) if sample_rate else 0.0
        start = word_timestamps[0]["start"] if word_timestamps else 0.0
        end = word_timestamps[-1]["end"] if word_timestamps else duration
        return {
            "text": text,
            "language": self._language,
            "word_timestamps": word_timestamps,
            "segments": ([{"text": text, "start": start, "end": end}] if text else []),
        }

    def _decode_capturing(
        self, audio: np.ndarray, prompt: str | None
    ) -> tuple[list[Any], list[str]]:
        """Run one decode while capturing whisper.cpp's native log for this
        thread. Must be called with ``self._lock`` held."""
        model = self._loaded.model
        # The ONE prompt channel: the agent's ``instruction.initialPrompt`` already
        # composed with the per-utterance carry-forward by the caller
        # (``compose_prompt``). ``""`` rather than ``None`` because the binding's
        # setter rejects None and the shared context persists params across calls.
        effective_prompt = " ".join(
            part for part in ((prompt or "").strip(), ", ".join(self._hotwords)) if part
        )
        # Word-timestamp mode forces near-word-sized segments (``max_len=1``,
        # ``split_on_word``) so each segment carries its own (t0, t1). This is
        # only requested when the pipeline consumes word timings; otherwise a
        # clean sentence-level decode is both faster and avoids the space-joining
        # corruption of non-space-delimited scripts (Malayalam).
        #
        # Every param below is passed EXPLICITLY on every call, never omitted.
        # pywhispercpp's ``_set_params`` setattrs only the kwargs it receives
        # onto a params object that persists across calls, and the whisper
        # context is shared with the batch/gloss adapters — an omitted kwarg
        # would silently inherit whatever a sibling adapter set last (e.g. a
        # pinned ``language="en"`` or ``max_len=1``).
        prev = getattr(_tls, "buffer", None)
        _tls.buffer = []
        try:
            segments = model.transcribe(
                audio,
                extract_probability=True,
                # Pure greedy, NO temperature fallback. whisper.cpp's default
                # fallback (temperature_inc=0.2) re-decodes with rising temperature
                # when a segment fails its entropy/logprob check — on this
                # code-switch fine-tune that reliably spirals into SAMPLED GARBAGE
                # (e.g. "eurysmbalination …") rather than recovering. Disabling the
                # fallback keeps the deterministic greedy hypothesis, which is
                # measured strictly better on real ml-en clinical audio.
                temperature=0.0,
                temperature_inc=0.0,
                token_timestamps=self._want_word_timestamps,
                split_on_word=self._want_word_timestamps,
                max_len=1 if self._want_word_timestamps else 0,
                # ``None`` is coerced to ``""`` by the binding's setter — both
                # mean auto-detect, which is the measured, load-bearing
                # behaviour for code-switch pairs.
                language=self._language if self._language else None,
                # The setter rejects ``None`` for ``initial_prompt``; ``""`` is
                # its neutral (tokenizes to nothing).
                initial_prompt=effective_prompt,
            )
        finally:
            logs = _tls.buffer
            _tls.buffer = prev
        return list(segments or []), logs

    def _rebuild_locked(self) -> bool:
        """Recreate the whisper context in place (shared ``LoadedModel.model``,
        so every adapter over it recovers). Returns ``False`` when the reload
        params are unavailable. Must be called with ``self._lock`` held."""
        extra = self._loaded.extra or {}
        model_path = extra.get("model_path")
        if not model_path:
            logger.error(
                "cannot recreate whisper.cpp context — no model_path recorded",
                model_slug=self._loaded.model_slug,
            )
            return False
        try:
            new_model = _construct_whisper_model(
                model_path,
                extra.get("num_threads"),
                self._loaded.device != "cpu",
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
        del old
        gc.collect()
        return True

    def _build_result(
        self, segments: list[Any], audio: np.ndarray, sample_rate: int
    ) -> dict[str, Any]:
        duration = len(audio) / float(sample_rate) if sample_rate else 0.0

        if self._want_word_timestamps:
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
                probability = seg.probability
                confidence = (
                    1.0 if probability is None or math.isnan(probability) else float(probability)
                )
                word_timestamps.append(
                    {
                        "word": word,
                        # pywhispercpp t0/t1 are whisper.cpp's raw 10ms units.
                        "start": seg.t0 / 100.0,
                        "end": seg.t1 / 100.0,
                        "confidence": confidence,
                    }
                )
            text = " ".join(w["word"] for w in word_timestamps)
            start = word_timestamps[0]["start"] if word_timestamps else 0.0
            end = word_timestamps[-1]["end"] if word_timestamps else duration
        else:
            # Clean sentence-level decode: rebuild the transcript by NATIVE
            # concatenation of segment text, preserving whisper's own spacing (its
            # byte-BPE attaches a leading space to word-initial tokens). This is the
            # ONLY correct reconstruction for non-space-delimited scripts like
            # Malayalam — space-joining segments would inject spurious spaces and
            # split grapheme clusters. No per-word timings in this mode.
            text = re.sub(r"\s+", " ", "".join(str(seg.text or "") for seg in segments)).strip()
            word_timestamps = []
            start, end = 0.0, duration

        return {
            "text": text,
            "language": self._language,
            "word_timestamps": word_timestamps,
            "segments": ([{"text": text, "start": start, "end": end}] if text else []),
        }
