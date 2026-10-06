"""TASK-1049 L1 — build the public / benign evaluation sets as JSONL, deterministically.

    python build_public_sets.py --out <DIR> [--cache <DIR>]

Writes ``a.jsonl``, ``b1.jsonl``, ``b3.jsonl``, ``c1.jsonl`` and
``public_sets_manifest.json``. Records are REGIONS (the bench windows them itself with
``core.iter_windows(text, 2000, 256)``). Needs network on first run; downloads land in
``--cache`` and are reused. ``HF_TOKEN`` (env) is used for the Hugging Face sources.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import re
import sys
import urllib.request
from collections.abc import Iterable, Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from injection_eval.core import iter_windows, render_production_regions  # noqa: E402

SEED = 1049
WINDOW_SIZE = 2000
WINDOW_OVERLAP = 256
SETS = ("a", "b1", "b3", "c1")
GOLDEN_FIXTURE = (
    Path(__file__).resolve().parents[4]
    / "apps/harness/src/harness/eval/golden/fixtures/multi_encounter_v1.json"
)
DEFAULT_CACHE = Path(
    "/private/tmp/claude-501/-Users-taphuynh-Desktop-igglo-ARCAAI-hope-v2/"
    "26731347-7742-4c11-bd04-5597cd5e80e3/scratchpad/task1049-cache"
)

_RAW = "https://raw." + "github" + "usercontent.com/"
ACI_URL = _RAW + "wyim/aci-bench/main/data/challenge_data/{}.csv"
ACI_FILES = [
    "train",
    "valid",
    "clinicalnlp_taskB_test1",
    "clinicalnlp_taskC_test2",
    "clef_taskC_test3",
]
MTS_URL = _RAW + "abachaa/MTS-Dialog/main/Main-Dataset/{}.csv"
MTS_FILES = [
    "MTS-Dialog-TrainingSet",
    "MTS-Dialog-ValidationSet",
    "MTS-Dialog-TestSet-1-MEDIQA-Chat-2023",
    "MTS-Dialog-TestSet-2-MEDIQA-Sum-2023",
]
HF_ROWS = "https://datasets-server.huggingface.co/"
NOTINJECT = "leolee99/NotInject"
DEEPSET = "deepset/prompt-injections"
GANDALF = "Lakera/gandalf_ignore_instructions"
SPML = "reshabhs/SPML_Chatbot_Prompt_Injection"

SOURCES: dict[str, list[dict[str, str]]] = {
    "a": [
        {"url": "apps/harness/.../golden/fixtures/multi_encounter_v1.json", "licence": "internal"}
    ],
    "b1": [
        {"url": "https://github.com/wyim/aci-bench", "licence": "CC BY 4.0"},
        {"url": "https://github.com/abachaa/MTS-Dialog", "licence": "CC BY 4.0"},
    ],
    "b3": [{"url": "https://huggingface.co/datasets/" + NOTINJECT, "licence": "MIT"}],
    "c1": [
        {"url": "https://huggingface.co/datasets/" + DEEPSET, "licence": "apache-2.0"},
        {"url": "https://huggingface.co/datasets/" + GANDALF, "licence": "MIT"},
        {"url": "https://huggingface.co/datasets/" + SPML, "licence": "MIT"},
    ],
}

# --------------------------------------------------------------------------- contract


def split_for(set_name: str, record_id: str) -> str:
    """Frozen split rule: only b1 is split (30 % dev by sha1 of the id); the rest are test."""
    if set_name != "b1":
        return "test"
    return "dev" if int(hashlib.sha1(record_id.encode()).hexdigest(), 16) % 10 < 3 else "test"


def make_record(record_id: str, set_name: str, label: int, text: str, meta: dict) -> dict:
    return {
        "id": record_id,
        "set": set_name,
        "split": split_for(set_name, record_id),
        "label": label,
        "text": text,
        "meta": meta,
    }


def validate_record(rec: dict) -> None:
    if set(rec) != {"id", "set", "split", "label", "text", "meta"}:
        raise ValueError(f"bad keys {sorted(rec)}")
    if not isinstance(rec["id"], str) or not rec["id"]:
        raise ValueError("id must be a non-empty str")
    if rec["set"] not in SETS:
        raise ValueError(f"bad set {rec['set']!r}")
    if rec["split"] not in ("dev", "test"):
        raise ValueError(f"bad split {rec['split']!r}")
    if rec["split"] != split_for(rec["set"], rec["id"]):
        raise ValueError(f"split violates the frozen rule for {rec['id']}")
    if isinstance(rec["label"], bool) or rec["label"] not in (0, 1):
        raise ValueError(f"bad label {rec['label']!r}")
    if not isinstance(rec["text"], str) or not rec["text"].strip():
        raise ValueError(f"empty text for {rec['id']}")
    if not isinstance(rec["meta"], dict) or not isinstance(rec["meta"].get("source"), str):
        raise ValueError(f"meta.source missing for {rec['id']}")


def assert_unique_ids(records: Iterable[dict]) -> None:
    seen: set[str] = set()
    for rec in records:
        if rec["id"] in seen:
            raise ValueError(f"duplicate id {rec['id']}")
        seen.add(rec["id"])


def window_count(text: str) -> int:
    return sum(1 for _ in iter_windows(text, WINDOW_SIZE, WINDOW_OVERLAP))


# --------------------------------------------------------------------------- parsers

_TAG = re.compile(r"^\[([A-Za-z_ ]+)\]\s*(.*)$")


def parse_aci_dialogue(raw: str) -> str:
    """``[doctor] hi\\n[patient] hello`` -> ``Doctor: hi\\nPatient: hello``.

    A line with no leading tag continues the previous turn (joined with a space).
    """
    turns: list[list[str]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        m = _TAG.match(line)
        if m:
            turns.append([m.group(1).strip().replace("_", " ").capitalize(), m.group(2).strip()])
        elif turns:
            turns[-1][1] = f"{turns[-1][1]} {line}".strip()
        else:
            turns.append(["Unknown", line])
    return "\n".join(f"{speaker}: {text}" for speaker, text in turns)


def build_mts_regions(dialogues: Sequence[str], *, min_chars: int, max_chars: int) -> list[str]:
    """Concatenate consecutive (deduped) dialogues with a blank line into transcript-sized
    regions of ``min_chars..max_chars``.

    Greedy: a region closes when the next dialogue would exceed ``max_chars`` and it already
    holds ``min_chars``. A short tail is folded into the previous region if it fits, else
    dropped; a lone dialogue longer than ``max_chars`` is emitted alone (cannot be bounded).
    """
    seen: set[str] = set()
    unique: list[str] = []
    for raw in dialogues:
        d = "\n".join(line.rstrip() for line in raw.strip().splitlines())
        if d and d not in seen:
            seen.add(d)
            unique.append(d)
    regions: list[str] = []
    current = ""
    for d in unique:
        candidate = d if not current else f"{current}\n\n{d}"
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if len(current) >= min_chars:
            regions.append(current)
            current = d
        else:  # too short to close and the next one does not fit: close what we have anyway
            if current:
                regions.append(current)
            current = d
    if current:
        if len(current) >= min_chars:
            regions.append(current)
        elif regions and len(regions[-1]) + 2 + len(current) <= max_chars:
            regions[-1] = f"{regions[-1]}\n\n{current}"
    return [r for r in regions if len(r) >= min_chars or len(r) > max_chars]


_DE_WORDS = {
    "ich", "und", "der", "die", "das", "nicht", "ist", "wie", "kann", "was", "ein", "eine",
    "zu", "mit", "für", "auf", "den", "dem", "sie", "wir", "es", "im", "von", "heute", "morgen",
    "bitte", "mir", "mich", "du", "ihr", "wer", "wo", "warum", "welche", "werden", "sind",
}  # fmt: skip


def detect_lang(text: str) -> str:
    """Heuristic: 'de' when German function words are >= 20 % of the tokens, else 'en'."""
    words = re.findall(r"[a-zäöüß]+", text.lower())
    if not words:
        return "en"
    hits = sum(1 for w in words if w in _DE_WORDS)
    return "de" if hits / len(words) >= 0.2 and hits >= 2 else "en"


def sample(items: Sequence, n: int, rng: random.Random) -> list:
    """Deterministic sample of at most ``n`` items, original order preserved."""
    if len(items) <= n:
        return list(items)
    keep = sorted(rng.sample(range(len(items)), n))
    return [items[i] for i in keep]


# --------------------------------------------------------------------------- builders


def build_golden_records() -> list[dict]:
    """One record per production DATA region of each golden case (TASK-1049 §8).

    `render_production_regions` mirrors the note composer; the earlier one-region
    ``Speaker: text`` rendering hid GLiGuard's short-window false positives.
    """
    data = json.loads(GOLDEN_FIXTURE.read_text(encoding="utf-8"))
    records = []
    for i, case in enumerate(data["cases"]):
        cid = str(case.get("caseId") or case.get("id") or f"case{i:03d}")
        for key, text in render_production_regions(case):
            records.append(
                make_record(
                    f"a:golden:{cid}:{key}",
                    "a",
                    0,
                    text,
                    {"source": "multi_encounter_v1", "case": cid, "region": key},
                )
            )
    return records


def _read_csv(path: Path) -> list[dict]:
    csv.field_size_limit(10**9)
    with path.open(encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def build_aci_records(cache: Path, files: Sequence[str] = ACI_FILES) -> list[dict]:
    records: list[dict] = []
    seen: set[str] = set()
    for name in files:
        for row in _read_csv(cache / f"{name}.csv"):
            text = parse_aci_dialogue(row["dialogue"])
            if not text or text in seen:
                continue
            seen.add(text)
            records.append(
                make_record(
                    f"b1:aci:{name}:{row['encounter_id']}",
                    "b1",
                    0,
                    text,
                    {"source": "ACI-Bench", "file": name, "encounter_id": row["encounter_id"]},
                )
            )
    return records


def build_mts_records(cache: Path, *, window_cap: int | None) -> list[dict]:
    dialogues: list[str] = []
    for name in MTS_FILES:
        dialogues.extend(row["dialogue"] for row in _read_csv(cache / f"{name}.csv"))
    records: list[dict] = []
    windows = 0
    for i, region in enumerate(build_mts_regions(dialogues, min_chars=1800, max_chars=4000)):
        if window_cap is not None and windows >= window_cap:
            break
        windows += window_count(region)
        records.append(make_record(f"b1:mts:R{i:04d}", "b1", 0, region, {"source": "MTS-Dialog"}))
    return records


def build_b1_records(cache: Path) -> list[dict]:
    aci = build_aci_records(cache)
    aci_windows = sum(window_count(r["text"]) for r in aci)
    mts = build_mts_records(cache, window_cap=300 if aci_windows > 900 else None)
    return aci + mts


def build_c1_records(
    deepset: Sequence[tuple[str, int, str]],
    gandalf: Sequence[tuple[str]],
    spml: Sequence[tuple[str, int]],
    *,
    gandalf_cap: int = 300,
    spml_cap: int = 300,
) -> list[dict]:
    """deepset: (text, label, split); gandalf: (text,) all label 1; spml: (text, label).

    Exact-text dedupe across the whole set; the first source to hold a text wins.
    """
    rng = random.Random(SEED)
    seen: set[str] = set()
    records: list[dict] = []

    def add(rid: str, label: int, text: str, meta: dict) -> None:
        if not text.strip() or text in seen:
            return
        seen.add(text)
        records.append(make_record(rid, "c1", label, text, meta))

    for i, (text, label, split) in enumerate(deepset):
        add(
            f"c1:deepset:{split}:{i:04d}",
            int(label),
            text,
            {"source": "deepset/prompt-injections", "hf_split": split, "lang": detect_lang(text)},
        )
    gandalf_unique = list(dict.fromkeys(t for (t,) in gandalf))
    for i, text in enumerate(sample(gandalf_unique, gandalf_cap, rng)):
        add(f"c1:gandalf:{i:04d}", 1, text, {"source": "Lakera/gandalf_ignore_instructions"})
    spml_inj = list(dict.fromkeys(t for t, lab in spml if int(lab) == 1))
    spml_ben = list(dict.fromkeys(t for t, lab in spml if int(lab) == 0))
    for i, text in enumerate(sample(spml_inj, spml_cap, rng)):
        add(f"c1:spml:inj:{i:04d}", 1, text, {"source": "SPML_Chatbot_Prompt_Injection"})
    for i, text in enumerate(sample(spml_ben, spml_cap, rng)):
        add(f"c1:spml:ben:{i:04d}", 0, text, {"source": "SPML_Chatbot_Prompt_Injection"})
    return records


# --------------------------------------------------------------------------- IO


def _download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(url, dest)  # noqa: S310 - fixed https URLs


def _hf_get(url: str) -> dict:
    token = os.environ.get("HF_TOKEN", "")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with urllib.request.urlopen(
        urllib.request.Request(url, headers=headers), timeout=120
    ) as r:  # noqa: S310
        return json.load(r)


def fetch_hf_rows(dataset: str, cache: Path) -> dict[str, list[dict]]:
    """All rows per split through the datasets-server JSON API (no parquet reader needed)."""
    path = cache / "hf_rows" / (dataset.replace("/", "__") + ".json")
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, list[dict]] = {}
    for sp in _hf_get(f"{HF_ROWS}splits?dataset={dataset}")["splits"]:
        rows: list[dict] = []
        offset = 0
        while True:
            url = (
                f"{HF_ROWS}rows?dataset={dataset}&config={sp['config']}"
                f"&split={sp['split']}&offset={offset}&length=100"
            )
            page = _hf_get(url)
            rows.extend(r["row"] for r in page["rows"])
            offset += len(page["rows"])
            if not page["rows"] or offset >= page["num_rows_total"]:
                break
        out[sp["split"]] = rows
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return out


def fetch_sources(cache: Path) -> None:
    for name in ACI_FILES:
        _download(ACI_URL.format(name), cache / f"{name}.csv")
    for name in MTS_FILES:
        _download(MTS_URL.format(name), cache / f"{name}.csv")


def load_spml(cache: Path) -> list[tuple[str, int]]:
    from huggingface_hub import hf_hub_download

    path = hf_hub_download(
        SPML,
        "spml_prompt_injection.csv",
        repo_type="dataset",
        token=os.environ.get("HF_TOKEN") or None,
        cache_dir=str(cache / "hf"),
    )
    return [(r["User Prompt"], int(r["Prompt injection"])) for r in _read_csv(Path(path))]


def build_b3_records(cache: Path) -> list[dict]:
    records: list[dict] = []
    for split, rows in fetch_hf_rows(NOTINJECT, cache).items():
        subset = split.removeprefix("NotInject_")
        for i, row in enumerate(rows):
            records.append(
                make_record(
                    f"b3:{subset}:{i:03d}",
                    "b3",
                    0,
                    row["prompt"],
                    {"source": "NotInject", "subset": subset, "category": row.get("category")},
                )
            )
    return records


def build_c1_from_sources(cache: Path) -> list[dict]:
    deepset = [
        (r["text"], r["label"], split)
        for split, rows in fetch_hf_rows(DEEPSET, cache).items()
        for r in rows
    ]
    gandalf = [(r["text"],) for rows in fetch_hf_rows(GANDALF, cache).values() for r in rows]
    return build_c1_records(deepset, gandalf, load_spml(cache))


def write_jsonl(path: Path, records: Sequence[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False, sort_keys=False) + "\n")


def manifest_entry(path: Path, records: Sequence[dict], *, sources: list[dict]) -> dict:
    labels: dict[str, int] = {}
    splits: dict[str, int] = {}
    for rec in records:
        labels[str(rec["label"])] = labels.get(str(rec["label"]), 0) + 1
        splits[rec["split"]] = splits.get(rec["split"], 0) + 1
    return {
        "file": path.name,
        "records": len(records),
        "windows": sum(window_count(r["text"]) for r in records),
        "labels": dict(sorted(labels.items())),
        "splits": dict(sorted(splits.items())),
        "sources": sources,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    args.cache.mkdir(parents=True, exist_ok=True)
    fetch_sources(args.cache)

    sets = {
        "a": build_golden_records(),
        "b1": build_b1_records(args.cache),
        "b3": build_b3_records(args.cache),
        "c1": build_c1_from_sources(args.cache),
    }
    manifest: dict = {"seed": SEED, "window": [WINDOW_SIZE, WINDOW_OVERLAP], "sets": {}}
    for name, records in sets.items():
        assert_unique_ids(records)
        for rec in records:
            validate_record(rec)
        path = args.out / f"{name}.jsonl"
        write_jsonl(path, records)
        manifest["sets"][name] = manifest_entry(path, records, sources=SOURCES[name])
    if manifest["sets"]["a"]["windows"] != 118:
        raise SystemExit(f"golden set must be 118 windows, got {manifest['sets']['a']['windows']}")
    (args.out / "public_sets_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(json.dumps({k: (v["records"], v["windows"]) for k, v in manifest["sets"].items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
