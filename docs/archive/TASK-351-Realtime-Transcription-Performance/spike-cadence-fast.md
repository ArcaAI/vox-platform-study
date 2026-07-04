# Spike: Cadence-Fast direct load under transformers 5.5.4

- **Ticket**: TASK-351 (Realtime Transcription Performance) — decision gate **D-2**, item **P2-2, Option A**
- **Date**: 2026-06-11
- **Status**: Complete
- **Spike artifact**: `scripts/spike-cadence-fast.py` (run via `conda run -n arcaenv --no-capture-output python scripts/spike-cadence-fast.py`)
- **Context**: Indic punctuation restoration is currently disabled because the `cadence-punctuation` wrapper package's dependency pin conflicts with the env (TASK-347 finding). Option A = load `ai4bharat/Cadence-Fast` directly via `transformers` `AutoModel` with `trust_remote_code=True`, bypassing the wrapper. Option B = sidecar process with its own venv.

## Verdict: GO for Option A (direct load)

`ai4bharat/Cadence-Fast` loads and runs correctly under the pinned `transformers==5.5.4` / `torch==2.8.0` in `arcaenv`, **with two non-default load kwargs** (see below). No package installs, no env changes, no wrapper package needed. Punctuation quality on Malayalam, Malayalam–English code-switched clinical text, and English samples was correct, including sentence splits and trailing question marks. Warm CPU inference is **~60–95 ms per short final** on this machine (M-series, 12 threads); RSS cost is **~0.9 GB** for the F32 weights.

## Environment verified

| Item | Value |
|---|---|
| conda env | `arcaenv` |
| python | 3.11.15 (macOS 26.5.1 arm64) |
| transformers | **5.5.4** (pinned) |
| torch | 2.8.0, CPU, 12 threads |
| model revision tested | `8971c5011e4fba5dcfbcac52744587d7da605534` (repo `main` at spike time, pinned in script) |

## Model facts (from HF model card + repo inspection)

- **`ai4bharat/Cadence-Fast`**: Gemma-3-270M converted to a bi-directional encoder, distilled from `ai4bharat/Cadence` (1B) for punctuation restoration (token classification, 31 labels). Paper: arXiv 2506.03793.
- **License: MIT.** Not gated.
- **Languages**: English + 22 Indic languages, **Malayalam (`ml`) officially supported**.
- **Size**: 268M params, single F32 safetensors file, **1.07 GB download**; config saved with `transformers_version: 4.57.1`.
- **Custom code**: one file, `modeling_gemma3_punctuation.py` (272 lines, audited during this spike). `config.json` `auto_map` routes `AutoModel`/`AutoModelForTokenClassification` to `Gemma3ForTokenClassification` (subclass of stock `Gemma3ForCausalLM` with a `Sequential(Dropout, Linear(640→31))` classifier head and non-causal attention overrides).
- **Label set** includes `.` `,` `?` `!` `;` `:` `-` quotes, ellipsis, parens, Hindi danda `।` (id 11), double danda `॥`, Urdu `۔ ، ؟`, Santali `᱾` combos.

## What happened (evidence)

### Attempt 1 — model-card recipe verbatim: FAILS on transformers 5.x

`AutoModel.from_pretrained("ai4bharat/Cadence-Fast", trust_remote_code=True)` downloads everything, then dies in load finalization:

```text
File ".../transformers/modeling_utils.py", line 4619, in mark_tied_weights_as_initialized
    param = self.get_parameter(tied_param)
File ".../torch/nn/modules/module.py", line 840, in get_parameter
    raise AttributeError(
AttributeError: Sequential has no attribute `weight`
```

**Root cause** (diagnosed, not guessed): the remote code replaces `lm_head` with `nn.Sequential(Dropout, Linear)`, but the class inherits `_tied_weights_keys = {"lm_head.weight": "model.embed_tokens.weight"}` from `Gemma3ForCausalLM`, and Gemma3's config defaults `tie_word_embeddings=True`. transformers 5.x's stricter tying plan (`mark_tied_weights_as_initialized`) unconditionally resolves `lm_head.weight`, which doesn't exist on a `Sequential` → hard `AttributeError`. (4.x tying was lenient, which is why the model card recipe worked on 4.57.)

**Fix — one kwarg, no env mutation**: `tie_word_embeddings=False` at load time. 5.5.4's `get_expanded_tied_weights_keys()` returns `{}` when the config flag is false, so the tying plan is skipped entirely. This is also semantically correct: the checkpoint ships explicit `lm_head.1.weight [31, 640]` + `lm_head.1.bias [31]` (verified in the safetensors header); nothing should ever be tied.

Secondary hazard: `AutoTokenizer.from_pretrained(MODEL_ID)` without `trust_remote_code=True` triggers an **interactive `[y/N]` prompt** (the repo config has custom `model_type: cadence_punctuation`), which would hang/abort CI. Pass `trust_remote_code=True` to the tokenizer call too (resolved class is stock `GemmaTokenizer`; no custom tokenizer code runs).

### Attempt 2 — with the fix: loads and runs cleanly (exit 0)

```text
tokenizer     : GemmaTokenizer loaded in 5.0s          (27.2s on first run incl. download)
model load    : 1.4s from warm cache                   (first run: ~1.07 GB download)
model class   : Gemma3ForTokenClassification | params: 268M | dtype: torch.float32
attn impl     : sdpa
loading_info  : missing=set() unexpected=set() mismatched=set()   ← perfect weight load
rss           : 231 MB before → 1059 MB after load → 1457 MB peak during inference
```

### Punctuation outputs (verbatim)

| Sample | Input (no punctuation) | Output | Warm latency |
|---|---|---|---|
| (a) Malayalam | രോഗിക്ക് രണ്ട് ദിവസമായി പനിയും തലവേദനയും ഉണ്ട് മരുന്ന് കഴിച്ചിട്ടും കുറയുന്നില്ല എന്താണ് ചെയ്യേണ്ടത് | രോഗിക്ക് രണ്ട് ദിവസമായി പനിയും തലവേദനയും ഉണ്ട്**.** മരുന്ന് കഴിച്ചിട്ടും കുറയുന്നില്ല**.** എന്താണ് ചെയ്യേണ്ടത്**?** | 61–68 ms |
| (b) ml–en code-switch, clinical | രാവിലെ paracetamol 500mg കഴിച്ചു എന്നിട്ടും temperature 101 degrees വരെ പോയി ഇനി blood test ചെയ്യണോ അതോ doctor നെ നേരിട്ട് കാണണോ | രാവിലെ paracetamol 500mg കഴിച്ചു എന്നിട്ടും temperature 101 degrees വരെ പോയി**.** ഇനി blood test ചെയ്യണോ അതോ doctor നെ നേരിട്ട് കാണണോ**?** | 76 ms |
| (c) English | hello doctor i have had chest pain since yesterday morning it gets worse when i climb stairs should i come in today | hello doctor**,** i have had chest pain since yesterday morning**.** it gets worse when i climb stairs**.** should i come in today**?** | 66–79 ms |

Quality assessment: sentence boundaries and the trailing question marks are exactly right in all three samples; the English comma after the vocative ("hello doctor,") is right. Code-switched drug name/dosage/units passed through untouched. First inference after load is ~1.6 s (one-time warmup); subsequent calls 60–95 ms.

### Danda (।) and Malayalam behavior

- **No danda was emitted for Malayalam — this is orthographically correct**: Malayalam uses Western `. , ?`; danda belongs to Devanagari-script languages (Hindi etc.), and `।` exists in the label set (id 11) for those.
- Note: the script's `marks:` line lists Malayalam combining vowel signs (ം ാ ി ു ്…) because the simple inventory check flags all non-alphanumerics; those are diacritics from the input text, not model-inserted punctuation. Model-inserted marks across all samples were exactly `.` `,` `?`.
- No capitalization in output ("hello doctor" not "Hello doctor") — capitalization is a rule-based extra in the `cadence-punctuation` wrapper, not in the model. Irrelevant for Malayalam; optional cheap post-rule for English finals if wanted.

### Critical 5.x semantics finding (silent, would have been missed without the spike)

The remote code achieves bidirectional (non-causal) attention by overriding `_update_causal_mask`. **transformers 5.x never calls `_update_causal_mask`** — Gemma3's forward builds masks via `create_causal_mask()` and the config flag `use_bidirectional_attention`. The hub `config.json` carries `use_bidirectional_attention: false` (serialized default from 4.57). Consequences under 5.5.4:

- As-loaded, the model runs with **causal** masks — silent drift from its bidirectional training setup. (Verified by instrumentation: the custom override is never invoked; only `is_causal=False` on the attention modules survives, which matters only for mask-less SDPA edge cases.)
- Setting `model.config.use_bidirectional_attention = True` post-load restores non-causal masking through the 5.x-native path. For inputs ≤ 512 tokens (`sliding_window=512`, every final fits trivially), this is mathematically identical to the fully-bidirectional behavior the remote code intended.
- Empirically, causal vs bidirectional produced **identical outputs on all three samples** (logits differ, argmax didn't flip here) — but production should set the flag to match training semantics; it costs nothing (it was even marginally faster: warm 61–76 ms vs 66–96 ms).

### Warnings observed (benign today, watch on upgrades)

- `` `use_return_dict` is deprecated! Use `return_dict` instead! `` — remote code touches `config.use_return_dict`; works in 5.5.4, likely breaks in transformers 6.x.
- "You are using a model of type `cadence_punctuation` to instantiate a model of type ``" and "generation flags not valid: ['cache_implementation']" — cosmetic.

## Exact working load + inference pattern

```python
from transformers import AutoModel, AutoTokenizer
import torch

MODEL_ID = "ai4bharat/Cadence-Fast"
REVISION = "8971c5011e4fba5dcfbcac52744587d7da605534"  # pin: code+weights audited at this sha

tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION, trust_remote_code=True)
model = AutoModel.from_pretrained(
    MODEL_ID,
    revision=REVISION,
    trust_remote_code=True,
    tie_word_embeddings=False,  # REQUIRED on transformers 5.x (see root cause above)
)
model.eval()
model.config.use_bidirectional_attention = True  # restore intended non-causal attention on 5.x
id2label = {int(k): v for k, v in model.config.id2label.items()}

def punctuate(text: str) -> str:
    inputs = tokenizer(text, return_tensors="pt", padding=True, truncation=True)
    with torch.inference_mode():
        preds = torch.argmax(model(**inputs).logits, dim=-1)[0]
    pieces = []
    for i, tok_id in enumerate(inputs["input_ids"][0].tolist()):
        if inputs["attention_mask"][0][i] == 0:
            continue
        special = tok_id in tokenizer.all_special_ids
        if not special:
            pieces.append(tokenizer.convert_ids_to_tokens([tok_id])[0])
            mark = id2label[preds[i].item()]
            if mark != "O":
                pieces.append(mark)
    return tokenizer.convert_tokens_to_string(pieces)
```

## Wiring recommendations for finals-only async integration (NOT implemented — production wiring is gated on coordinator approval)

1. **Load once at service startup** in a thread executor (cached load 1.4 s + ~5 s tokenizer; first download 1.07 GB). Run one **warmup inference** at startup to absorb the ~1.6 s cold-start before serving.
2. **Finals-only, async, with timeout + raw-text fallback**: run `punctuate()` in a threadpool via `asyncio.wait_for(...)`; warm latency is 60–95 ms per short final on dev CPU, so a **300–500 ms budget** is comfortable; on timeout or any exception, emit the raw final unchanged. Never block the streaming path.
3. **Serialize access** (single-flight queue or `max_workers=1` executor): one 268M F32 forward already uses multiple CPU threads; concurrent forwards on the STT box would contend with decoding.
4. **Pin `revision=`** (supply-chain hygiene for `trust_remote_code`) and consider `HF_HUB_OFFLINE=1` at runtime once the cache is warm. The custom module is one auditable file.
5. **Memory budget ~1.1 GB RSS** (F32). If that's too high for the deployment, test `dtype=torch.bfloat16` (wrapper's default) in a follow-up — NOT validated in this spike.
6. **Config flags to carry**: `trust_remote_code=True`, `tie_word_embeddings=False`, post-load `use_bidirectional_attention=True`, `truncation=True` (finals ≪ 512-token window, so no sliding-window chunking needed — that wrapper feature is irrelevant here).
7. Gate any transformers **6.x upgrade** on re-running `scripts/spike-cadence-fast.py` (the remote code's `use_return_dict` usage is already deprecated).

## Risks / open items

- **Accuracy**: this spike proves feasibility + plausible quality on 3 samples; it is not an accuracy benchmark on real clinical Malayalam finals (out of D-2 scope).
- **Remote code execution**: mitigated by revision pin + the one-file audit done here; re-audit on any revision bump.
- The wrapper's rule-based English capitalization and model-error corrections are not included; acceptable for finals-only Malayalam-first usage.

## Files created by this spike

- `scripts/spike-cadence-fast.py` — runnable spike (exit 0 = GO evidence reproducible)
- `docs/implementation/TASK-351-Realtime-Transcription-Performance/spike-cadence-fast.md` — this document
