"""TASK-1049 L4 — build the safety (s) and off-scope (o) evaluation sets as JSONL.

    python build_guardrail_sets.py --out <DIR> --cache <DIR>
        [--clinical-bases /Volumes/aillusion/task-1049-data/sets/b1.jsonl]

Set ``s`` (T2, safety/toxicity): Aegis 2.0 prompts with their prompt-level human label.
Set ``o`` (T3, medical scope): Dolly off-scope instructions, standalone and embedded as a
directive line inside a benign clinical region. Records are REGIONS (the bench windows them
itself at 2,000 / 256). ``HF_TOKEN`` (env) is used for the Hugging Face sources.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Iterable, Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from injection_eval.build_public_sets import HF_ROWS, window_count  # noqa: E402
from injection_eval.core import embed_payload  # noqa: E402

SEED = 1049
REGION_CHARS = 2000
SETS = ("s", "o")
AEGIS = "nvidia/Aegis-AI-Content-Safety-Dataset-2.0"
DOLLY = "databricks/databricks-dolly-15k"
DEFAULT_BASES = Path("/Volumes/aillusion/task-1049-data/sets/b1.jsonl")
AEGIS_SPLIT_PREFERENCE = ("test", "validation", "train")
DOLLY_CATEGORIES = ("creative_writing", "brainstorming", "open_qa", "general_qa")
DOLLY_MIN_CHARS, DOLLY_MAX_CHARS = 20, 400

SOURCES: dict[str, list[dict[str, str]]] = {
    "s": [{"url": "https://huggingface.co/datasets/" + AEGIS, "licence": "CC-BY-4.0"}],
    "o": [
        {"url": "https://huggingface.co/datasets/" + DOLLY, "licence": "CC-BY-SA-3.0"},
        {"url": "apps/nlp b1.jsonl (ACI-Bench / MTS-Dialog bases)", "licence": "CC BY 4.0"},
    ],
}

# Stems matched at a word start; clinical text discusses these benignly, so the safety set
# flags them (meta.medical_topic) and the off-scope set must not contain them at all.
_MEDICAL_STEMS = (
    r"medic",
    r"overdos",
    r"dose\b",
    r"doses\b",
    r"dosage",
    r"drug",
    r"prescri",
    r"suicid",
    r"self[- ]harm",
    r"surgery",
    r"surgeon",
    r"surgical",
    r"patient",
    r"doctor",
    r"hospital",
    r"clinic",
    r"symptom",
    r"diagnos",
    r"disease",
    r"illness",
    r"cancer",
    r"tumou?r",
    r"pills?\b",
    r"pharmac",
    r"therap",
    r"mental health",
    r"depress",
    r"anxiety",
    r"injur",
    r"pain\b",
    r"health",
    r"blood",
    r"infect",
    r"vaccin",
    r"abortion",
    r"pregnan",
    r"opioid",
    r"insulin",
    r"nurse",
    r"antibiotic",
    r"anorexi",
    r"poison",
)
_MEDICAL_RE = re.compile(r"\b(?:" + "|".join(_MEDICAL_STEMS) + ")", re.IGNORECASE)

# --------------------------------------------------------------------------- contract


def split_for(record_id: str) -> str:
    """Frozen split rule: 30 % dev by sha1 of the id."""
    return "dev" if int(hashlib.sha1(record_id.encode()).hexdigest(), 16) % 10 < 3 else "test"


def make_record(record_id: str, set_name: str, label: int, text: str, meta: dict) -> dict:
    return {
        "id": record_id,
        "set": set_name,
        "split": split_for(record_id),
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
    if rec["split"] != split_for(rec["id"]):
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


def mentions_medical(text: str) -> bool:
    return bool(_MEDICAL_RE.search(text))


# --------------------------------------------------------------------------- set s


def aegis_record(row: dict, aegis_split: str, index: int) -> dict | None:
    """One Aegis 2.0 row -> record (prompt + `prompt_label`), or None when unusable.

    Real columns: id, reconstruction_id_if_redacted, prompt, response, prompt_label
    (safe|unsafe), response_label, violated_categories (comma-separated str),
    prompt_label_source, response_label_source. Redacted prompts are the literal "REDACTED".
    """
    prompt = (row.get("prompt") or "").strip()
    if not prompt or prompt == "REDACTED":
        return None
    label = {"safe": 0, "unsafe": 1}.get(str(row.get("prompt_label") or "").strip().lower())
    if label is None:
        return None
    cats = [c.strip() for c in (row.get("violated_categories") or "").split(",") if c.strip()]
    rid = f"s:aegis:{aegis_split}:{row.get('id') or index}"
    return make_record(
        rid,
        "s",
        label,
        prompt,
        {
            "source": "Aegis-2.0",
            "aegis_split": aegis_split,
            "categories": cats,
            "hazard": cats[0] if cats else "none",
            "medical_topic": mentions_medical(prompt),
        },
    )


def _usable_aegis(rows: Sequence[dict], aegis_split: str) -> list[dict]:
    """Records of one split, exact-text deduped; texts carrying both labels are dropped."""
    first: dict[str, dict] = {}
    conflicted: set[str] = set()
    for i, row in enumerate(rows):
        rec = aegis_record(row, aegis_split, i)
        if rec is None:
            continue
        prior = first.get(rec["text"])
        if prior is None:
            first[rec["text"]] = rec
        elif prior["label"] != rec["label"]:
            conflicted.add(rec["text"])
    return [r for t, r in first.items() if t not in conflicted]


def build_s_records(rows_by_split: dict[str, list[dict]], *, n_per_label: int = 600) -> list[dict]:
    """Balanced deterministic sample from the first preferred split with enough of each label."""
    rng = random.Random(SEED)
    for split in AEGIS_SPLIT_PREFERENCE:
        if split not in rows_by_split:
            continue
        recs = _usable_aegis(rows_by_split[split], split)
        unsafe = [r for r in recs if r["label"] == 1]
        safe = [r for r in recs if r["label"] == 0]
        if len(unsafe) >= n_per_label and len(safe) >= n_per_label:
            return rng.sample(unsafe, n_per_label) + rng.sample(safe, n_per_label)
    raise ValueError(f"no Aegis split has {n_per_label} usable prompts of each label")


# --------------------------------------------------------------------------- set o

_PREFIXES = ("Patient: AI assistant, ", "Doctor: Scribe, before the note, ")


def _one_line(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def dolly_candidates(rows: Sequence[dict]) -> list[tuple[str, str]]:
    """(category, instruction) of genuinely off-scope, length-bounded, deduped instructions."""
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for row in rows:
        category = row.get("category")
        if category not in DOLLY_CATEGORIES:
            continue
        text = _one_line(row.get("instruction") or "")
        if not DOLLY_MIN_CHARS <= len(text) <= DOLLY_MAX_CHARS:
            continue
        if mentions_medical(text) or text in seen:
            continue
        seen.add(text)
        out.append((category, text))
    return out


def embed_instruction(
    base: str, instruction: str, variant: int, rng: random.Random
) -> tuple[str, int]:
    """Insert the directive as its own line; return (region, char offset of that line)."""
    line = _PREFIXES[variant % 2] + instruction
    text = embed_payload(base, line, "", rng, max_chars=REGION_CHARS)
    return text, text.index(line)


def build_o_records(
    dolly_rows: Sequence[dict],
    bases: Sequence[dict],
    *,
    n_standalone: int = 300,
    n_embedded: int = 300,
) -> list[dict]:
    rng = random.Random(SEED)
    cands = dolly_candidates(dolly_rows)
    need = n_standalone + n_embedded
    if len(cands) < need:
        raise ValueError(f"only {len(cands)} off-scope Dolly instructions, need {need}")
    pool = rng.sample(cands, need)  # disjoint: standalone and embedded never share a text
    records: list[dict] = []
    for i, (category, text) in enumerate(pool[:n_standalone]):
        records.append(
            make_record(
                f"o:standalone:{i:04d}",
                "o",
                1,
                text,
                {"source": "dolly-15k", "dolly_category": category, "carrier": "standalone"},
            )
        )
    for i, (category, text) in enumerate(pool[n_standalone:]):
        base = bases[rng.randrange(len(bases))]
        region, offset = embed_instruction(base["text"], text, i, rng)
        records.append(
            make_record(
                f"o:embedded:{i:04d}",
                "o",
                1,
                region,
                {
                    "source": "dolly-15k",
                    "dolly_category": category,
                    "base_id": base["id"],
                    "carrier": "embedded_directive",
                    "offset": offset,
                },
            )
        )
    return records


# --------------------------------------------------------------------------- IO


def _hf_get(url: str, *, retries: int = 8) -> dict:
    """GET JSON from the datasets-server, backing off on 429 / transient 5xx."""
    token = os.environ.get("HF_TOKEN", "")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=120) as r:  # noqa: S310 - fixed https
                return json.load(r)
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise
            time.sleep(min(60.0, float(exc.headers.get("Retry-After") or 2 ** (attempt + 1))))
    raise AssertionError("unreachable")


def fetch_split_rows(dataset: str, split: str, cache: Path) -> list[dict]:
    """All rows of one split (config `default`), cached as JSON in `cache`."""
    path = cache / "hf_rows" / f"{dataset.replace('/', '__')}.{split}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    rows: list[dict] = []
    offset = 0
    while True:
        page = _hf_get(
            f"{HF_ROWS}rows?dataset={dataset}&config=default&split={split}"
            f"&offset={offset}&length=100"
        )
        rows.extend(r["row"] for r in page["rows"])
        offset += len(page["rows"])
        if not page["rows"] or offset >= page["num_rows_total"]:
            break
        time.sleep(0.25)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    return rows


def load_bases(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def write_jsonl(path: Path, records: Sequence[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


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
    ap.add_argument("--cache", required=True, type=Path)
    ap.add_argument("--clinical-bases", type=Path, default=DEFAULT_BASES)
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    args.cache.mkdir(parents=True, exist_ok=True)

    bases = [r for r in load_bases(args.clinical_bases) if r.get("set") == "b1"]
    if not bases:
        raise SystemExit(f"no b1 records in {args.clinical_bases}")
    dolly = fetch_split_rows(DOLLY, "train", args.cache)
    aegis: dict[str, list[dict]] = {}
    s_records: list[dict] = []
    for split in AEGIS_SPLIT_PREFERENCE:  # fetch lazily: only as far as needed
        aegis[split] = fetch_split_rows(AEGIS, split, args.cache)
        try:
            s_records = build_s_records(aegis)
            break
        except ValueError:
            continue
    if not s_records:
        raise SystemExit("no Aegis split has enough usable prompts")

    sets = {"s": s_records, "o": build_o_records(dolly, bases)}
    manifest: dict = {"seed": SEED, "window": [REGION_CHARS, 256], "sets": {}}
    for name, records in sets.items():
        assert_unique_ids(records)
        for rec in records:
            validate_record(rec)
        path = args.out / f"{name}.jsonl"
        write_jsonl(path, records)
        entry = manifest_entry(path, records, sources=SOURCES[name])
        if name == "s":
            unsafe = [r for r in records if r["label"] == 1]
            entry["unsafe_medical_topic"] = sum(r["meta"]["medical_topic"] for r in unsafe)
            entry["aegis_split"] = records[0]["meta"]["aegis_split"]
        manifest["sets"][name] = entry
    (args.out / "guardrail_sets_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(json.dumps({k: (v["records"], v["windows"]) for k, v in manifest["sets"].items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
