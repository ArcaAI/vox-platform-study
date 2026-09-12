#!/usr/bin/env python
"""Cadence-Fast decision-gate spike (direct transformers load).

Question: can `ai4bharat/Cadence-Fast` (Indic punctuation restoration) be loaded
and used DIRECTLY via transformers AutoModel/AutoTokenizer with
trust_remote_code=True under the pinned transformers==5.5.4 in conda env
`arcaenv` — bypassing the `cadence-punctuation` wrapper package (whose 4.x-era
dependency pin conflicts)?

Usage:
    conda run -n arcaenv --no-capture-output python scripts/spike-cadence-fast.py

Exit codes:
    0 = load + inference succeeded on all samples
    2 = model load failed
    3 = inference failed
    4 = tokenizer load failed

SPIKE ONLY — no production wiring. Findings:
"""

import os

# Hygiene before importing transformers.
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import platform
import sys
import time
import traceback

MODEL_ID = "ai4bharat/Cadence-Fast"
# Pin to the repo sha current at spike time (2026-06-11) so the remote code and
# weights audited in this spike are exactly what gets executed.
REVISION = "8971c5011e4fba5dcfbcac52744587d7da605534"

# (label, text) — punctuation-free inputs, clinical flavour, trailing questions.
SAMPLES: list[tuple[str, str]] = [
    (
        "(a) Malayalam",
        "രോഗിക്ക് രണ്ട് ദിവസമായി പനിയും തലവേദനയും ഉണ്ട് മരുന്ന് കഴിച്ചിട്ടും കുറയുന്നില്ല എന്താണ് ചെയ്യേണ്ടത്",
    ),
    (
        "(b) Malayalam-English code-switch (clinical)",
        "രാവിലെ paracetamol 500mg കഴിച്ചു എന്നിട്ടും temperature 101 degrees വരെ പോയി ഇനി blood test ചെയ്യണോ അതോ doctor നെ നേരിട്ട് കാണണോ",
    ),
    (
        "(c) English",
        "hello doctor i have had chest pain since yesterday morning it gets worse when i climb stairs should i come in today",
    ),
]

DANDA = "\u0964"  # ।


def rss_mb() -> float:
    """Current process max RSS in MB (macOS reports ru_maxrss in bytes, Linux in KB)."""
    import resource

    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / (1024 * 1024) if sys.platform == "darwin" else peak / 1024


def punctuate(text: str, model, tokenizer, id2label: dict[int, str]) -> tuple[str, float]:
    """Model-card decode loop: argmax per token, append predicted mark after token."""
    import torch

    start = time.perf_counter()
    inputs = tokenizer(text, return_tensors="pt", padding=True, truncation=True)
    with torch.inference_mode():
        outputs = model(**inputs)
        predictions = torch.argmax(outputs.logits, dim=-1)[0]

    input_ids = inputs["input_ids"][0]
    token_strings = tokenizer.convert_ids_to_tokens(input_ids.tolist())
    pieces: list[str] = []
    for i, token_id in enumerate(input_ids.tolist()):
        if inputs["attention_mask"][0][i] == 0:
            continue
        is_special = token_id in tokenizer.all_special_ids
        if not is_special:
            pieces.append(token_strings[i])
        mark = id2label[predictions[i].item()]
        if mark != "O" and not is_special:
            pieces.append(mark)
    result = tokenizer.convert_tokens_to_string(pieces)
    return result, time.perf_counter() - start


def marks_in(text: str) -> str:
    found = sorted({ch for ch in text if not ch.isalnum() and not ch.isspace()})
    return " ".join(found) if found else "(none)"


def run_samples(tag: str, model, tokenizer, id2label: dict[int, str]) -> bool:
    print(f"\n--- inference: {tag} ---")
    ok = True
    for label, text in SAMPLES:
        try:
            result, secs = punctuate(text, model, tokenizer, id2label)
        except Exception:
            print(f"[FAIL] {label}: inference raised:")
            traceback.print_exc()
            ok = False
            continue
        print(f"{label}  [{secs * 1000:.0f} ms]")
        print(f"  in : {text}")
        print(f"  out: {result}")
        print(f"  marks: {marks_in(result)} | danda(।) present: {DANDA in result}")
    return ok


def main() -> int:
    import torch
    import transformers

    print("=== D-2 spike: ai4bharat/Cadence-Fast direct load ===")
    print(f"python        : {platform.python_version()} ({platform.platform()})")
    print(f"transformers  : {transformers.__version__}")
    print(f"torch         : {torch.__version__} | cpu threads: {torch.get_num_threads()}")
    print(f"model         : {MODEL_ID} @ {REVISION[:12]}")
    print(f"rss before    : {rss_mb():.0f} MB")

    try:
        t0 = time.perf_counter()
        from transformers import AutoTokenizer

        # trust_remote_code also here: the repo config has a custom model_type, so
        # AutoTokenizer otherwise raises an interactive [y/N] prompt (CI hazard).
        tokenizer = AutoTokenizer.from_pretrained(
            MODEL_ID, revision=REVISION, trust_remote_code=True
        )
        print(
            f"tokenizer     : {type(tokenizer).__name__} loaded in {time.perf_counter() - t0:.1f}s"
        )
    except Exception:
        print("[FAIL] tokenizer load failed:")
        traceback.print_exc()
        return 4

    try:
        t0 = time.perf_counter()
        from transformers import AutoModel

        model, loading_info = AutoModel.from_pretrained(
            MODEL_ID,
            revision=REVISION,
            trust_remote_code=True,
            output_loading_info=True,
            # REQUIRED under transformers 5.x: the remote code replaces lm_head
            # with Sequential(Dropout, Linear), but Gemma3ForCausalLM inherits
            # _tied_weights_keys = {"lm_head.weight": "model.embed_tokens.weight"}
            # and 5.x load finalization hard-fails resolving that path
            # (AttributeError: Sequential has no attribute `weight`).
            # tie_word_embeddings=False empties the tying plan; the checkpoint
            # ships explicit lm_head.1.{weight,bias}, so nothing should be tied.
            tie_word_embeddings=False,
        )
        load_secs = time.perf_counter() - t0
        model.eval()
    except Exception as exc:
        print("[FAIL] model load failed:")
        traceback.print_exc()
        if isinstance(exc, (ImportError, AttributeError, TypeError)):
            print("diagnosis hint: remote code vs transformers 5.x API incompatibility")
        elif isinstance(exc, ModuleNotFoundError):
            print(f"diagnosis hint: missing dependency: {exc.name}")
        return 2

    n_params = sum(p.numel() for p in model.parameters())
    head = model.lm_head[1].weight
    print(f"model load    : {load_secs:.1f}s (includes download on first run)")
    print(
        f"model class   : {type(model).__name__} | params: {n_params / 1e6:.0f}M | dtype: {head.dtype}"
    )
    print(f"attn impl     : {model.config._attn_implementation}")
    print(f"head          : lm_head[1] {tuple(head.shape)} | labels: {len(model.config.id2label)}")
    print(
        f"loading_info  : missing={loading_info['missing_keys']} unexpected={loading_info['unexpected_keys']} "
        f"mismatched={loading_info['mismatched_keys']}"
    )
    print(
        f"config flags  : use_non_causal_attention={getattr(model.config, 'use_non_causal_attention', None)} "
        f"use_bidirectional_attention={getattr(model.config, 'use_bidirectional_attention', None)}"
    )
    print(f"rss after load: {rss_mb():.0f} MB")

    id2label = {int(k): v for k, v in model.config.id2label.items()}

    # Variant 1 — exactly as loaded (hub config). In transformers 5.x the remote
    # code's _update_causal_mask override is never invoked, so this runs with
    # CAUSAL masks (semantics drift vs. the bidirectional training setup).
    ok = run_samples("as-loaded hub config (causal under 5.x)", model, tokenizer, id2label)

    # Variant 2 — 5.x-native bidirectional masking, which restores the intent of
    # the remote code's dead override. Masks are rebuilt per forward from config,
    # so an in-place flip is sufficient.
    model.config.use_bidirectional_attention = True
    ok = (
        run_samples("use_bidirectional_attention=True (5.x-native fix)", model, tokenizer, id2label)
        and ok
    )

    # Warm repeat of sample (a) for a steady-state latency number.
    result, secs = punctuate(SAMPLES[0][1], model, tokenizer, id2label)
    print(f"\nwarm repeat (a) [bidirectional]: {secs * 1000:.0f} ms")
    print(f"rss peak      : {rss_mb():.0f} MB")

    if not ok:
        return 3
    print("\n=== SPIKE RESULT: load OK, inference OK on all samples ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
