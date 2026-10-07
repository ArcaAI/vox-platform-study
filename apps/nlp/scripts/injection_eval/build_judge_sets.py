"""TASK-1049 S-4 — build the TASK-1050 safety-judge evaluation sets as JSONL, deterministically.

    python build_judge_sets.py --out <DIR> [--cache <DIR>] [--guard-s <s.jsonl>] [--b1 <b1.jsonl>]

Writes ``oc.jsonl`` (outbound clinical safety), ``ol.jsonl`` (outbound leakage), ``on.jsonl``
(clinical benign notes), ``iu.jsonl`` (inbound unsafe content) and ``judge_sets_manifest.json``.

Rule-built only: every synthetic record comes from the slot tables in ``judge_templates.json``
(no LLM, no model, no network). ``on`` reads the cached ACI-Bench / MTS-Dialog CSVs; ``iu``
reads the Aegis requests of ``sets-guard/s.jsonl`` and the benign transcript bases of
``sets/b1.jsonl``.

Record contract (one JSON object per line):
    {"id", "set", "split": "dev"|"test", "label": 0|1, "text", "meta"}
``split`` is ``dev`` when ``int(sha1(meta.group_id)) % 10 < 3``; a positive and its benign twin
share a ``group_id`` and therefore a split. ``text`` is a REGION; the bench windows it at
2,000 / 256 with ``core.iter_windows``.

Offline evaluation tooling only — nothing in the ``nlp`` service imports it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from injection_eval.build_guardrail_sets import (  # noqa: E402
    AEGIS,
    _usable_aegis,
    fetch_split_rows,
)
from injection_eval.build_public_sets import (  # noqa: E402
    ACI_FILES,
    MTS_FILES,
    _read_csv,
    sample,
)
from injection_eval.core import embed_payload, iter_windows  # noqa: E402

HERE = Path(__file__).resolve().parent
TEMPLATES = HERE / "judge_templates.json"
DATA = Path("/Volumes/aillusion/task-1049-data")

SEED = 1049
WINDOW_SIZE = 2000
WINDOW_OVERLAP = 256
SETS = ("oc", "ol", "on", "iu")
OC_CATEGORIES = (
    "dangerous_dosing",
    "unsupported_assertion",
    "direct_patient_instruction",
    "missed_escalation",
)
OL_CATEGORIES = ("system_prompt", "credential", "internal_identifier", "third_party_pii")
OC_PER_CATEGORY = 64
OL_PER_CATEGORY = 44
NOTE_MIN, NOTE_MAX = 400, 1800
MAX_FILLER = 6
IU_MAX_CHARS = 2000
IU_MAX_REQUEST = 600
ACI_CAP = 250
MTS_CAP = 150

TEMPLATE_SOURCE = "TASK-1049 S-4 rule-built templates (judge_templates.json)"
LICENCES = {
    "oc": [{"source": TEMPLATE_SOURCE, "licence": "internal (synthetic)"}],
    "ol": [{"source": TEMPLATE_SOURCE, "licence": "internal (synthetic, fake secrets)"}],
    "on": [
        {"source": "https://github.com/wyim/aci-bench (note column)", "licence": "CC BY 4.0"},
        {"source": "https://github.com/abachaa/MTS-Dialog (section_text)", "licence": "CC BY 4.0"},
    ],
    "iu": [
        {
            "source": "https://huggingface.co/datasets/nvidia/Aegis-AI-Content-Safety-Dataset-2.0",
            "licence": "CC-BY-4.0",
        },
        {"source": "b1.jsonl bases (ACI-Bench / MTS-Dialog dialogues)", "licence": "CC BY 4.0"},
        {"source": TEMPLATE_SOURCE, "licence": "internal (synthetic)"},
    ],
}

# --------------------------------------------------------------------------- contract


def group_split(group_id: str) -> str:
    return "dev" if int(hashlib.sha1(group_id.encode()).hexdigest(), 16) % 10 < 3 else "test"


def make_record(
    record_id: str, set_name: str, label: int, text: str, meta: dict, group_id: str
) -> dict:
    return {
        "id": record_id,
        "set": set_name,
        "split": group_split(group_id),
        "label": label,
        "text": text,
        "meta": {**meta, "group_id": group_id},
    }


def validate_record(rec: dict) -> None:
    if set(rec) != {"id", "set", "split", "label", "text", "meta"}:
        raise ValueError(f"bad keys {sorted(rec)}")
    if not isinstance(rec["id"], str) or not rec["id"]:
        raise ValueError("id must be a non-empty str")
    if rec["set"] not in SETS:
        raise ValueError(f"bad set {rec['set']!r}")
    if isinstance(rec["label"], bool) or rec["label"] not in (0, 1):
        raise ValueError(f"bad label {rec['label']!r}")
    if not isinstance(rec["text"], str) or not rec["text"].strip():
        raise ValueError(f"empty text for {rec['id']}")
    meta = rec["meta"]
    for key in ("source", "category", "group_id"):
        if not isinstance(meta, dict) or not isinstance(meta.get(key), str):
            raise ValueError(f"meta.{key} missing for {rec['id']}")
    if rec["split"] != group_split(meta["group_id"]):
        raise ValueError(f"split violates the group rule for {rec['id']}")


def load_templates(path: Path = TEMPLATES) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- note rendering


def _intro(row: dict, rng: random.Random) -> str:
    age_lo, age_hi = row.get("age", [25, 82])
    age = rng.randint(age_lo, age_hi)
    sex = row.get("intro_sex") or rng.choice(["male", "female"])
    return row.get("intro") or f"{age}-year-old {sex}"


def _block(header: str, body: str) -> str:
    return f"{header} {body}" if len(header) <= 3 else f"{header}\n{body}"


def _render(frame: dict, sections: dict[str, str], *, lead: list[str] | None = None) -> str:
    blocks = [frame["title"]] if frame["title"] else []
    blocks += lead or []
    blocks += [_block(frame["headers"][k], sections[k]) for k in ("S", "O", "A", "P")]
    return "\n\n".join(blocks)


def _fill_pair(
    frame: dict,
    pos: dict[str, str],
    twin: dict[str, str],
    pool: list[str],
    rng: random.Random,
) -> tuple[str, str]:
    """Append the SAME filler sentences (at most MAX_FILLER) to S of both versions until both
    reach a random target length in [450, 1100]; never past NOTE_MAX. The pair differs only in
    the swap."""
    target = rng.randint(450, 1100)
    order = rng.sample(pool, len(pool))[:MAX_FILLER]
    extra: list[str] = []

    def render(base: dict[str, str], fill: list[str]) -> str:
        return _render(frame, {**base, "S": " ".join([base["S"], *fill])})

    for sentence in order:
        a, b = render(pos, extra), render(twin, extra)
        if min(len(a), len(b)) >= target:
            break
        trial = [*extra, sentence]
        if max(len(render(pos, trial)), len(render(twin, trial))) > NOTE_MAX:
            break
        extra = trial
    return render(pos, extra), render(twin, extra)


def _o_section(row: dict, filler: dict, rng: random.Random) -> str:
    if row.get("O"):
        return row["O"]
    exam = rng.sample(filler["exam"], 2)
    return " ".join([rng.choice(filler["vitals"]), *exam])


def _plan_tail(filler: dict, rng: random.Random) -> str:
    return " ".join(rng.sample(filler["plan"], 2))


def _cap(text: str) -> str:
    return text[:1].upper() + text[1:]


# --------------------------------------------------------------------------- oc


def _oc_sections(category: str, row: dict, t: dict, rng: random.Random) -> tuple[dict, dict]:
    filler = t["filler"]
    intro = _cap(_intro(row, rng))
    if category == "dangerous_dosing":
        verb = rng.choice(t["plan_verbs"])
        base = {
            "S": f"{intro}. {row['history']}",
            "O": _o_section(row, filler, rng),
            "A": row["assessment"],
        }
        tail = _plan_tail(filler, rng)
        plan = f"{verb} {{R}} for {row['indication']}. {tail}"
        pos = {**base, "P": plan.replace("{R}", row["dangerous_regimen"])}
        twin = {**base, "P": plan.replace("{R}", row["safe_regimen"])}
        return pos, twin
    base = {
        "S": f"{intro}. {row['S']}",
        "O": _o_section(row, filler, rng) if category != "missed_escalation" else row["O"],
        "A": row["A"],
        "P": row["P"],
    }
    if category != "missed_escalation":
        base["P"] = f"{base['P']} {_plan_tail(filler, rng)}"
    pos = {k: v.replace("{V}", row["unsafe"]) for k, v in base.items()}
    twin = {k: v.replace("{V}", row["safe"]) for k, v in base.items()}
    return pos, twin


def build_oc(t: dict, *, per_category: int = OC_PER_CATEGORY) -> list[dict]:
    records: list[dict] = []
    seen: set[str] = set()
    for category in OC_CATEGORIES:
        rows = t[category]
        for i in range(per_category):
            row = rows[i % len(rows)]
            for attempt in range(50):
                rng = random.Random(f"{SEED}:oc:{category}:{i}:{attempt}")
                frame = rng.choice(t["frames"])
                pos_s, twin_s = _oc_sections(category, row, t, rng)
                adult = "intro" not in row
                pool = (t["filler"]["history"] if adult else []) + t["filler"]["admin"]
                pos_text, twin_text = _fill_pair(frame, pos_s, twin_s, pool, rng)
                ok_len = all(NOTE_MIN <= len(x) <= NOTE_MAX for x in (pos_text, twin_text))
                if ok_len and pos_text not in seen and twin_text not in seen:
                    break
            else:  # pragma: no cover - template tables too small
                raise RuntimeError(f"cannot render a unique note for {category} #{i}")
            seen.update((pos_text, twin_text))
            gid = f"oc:{category}:{i:03d}"
            key = row.get("drug") or row["topic"]
            meta = {"source": TEMPLATE_SOURCE, "category": category, "frame": frame["id"]}
            meta.update({"drug": key} if category == "dangerous_dosing" else {"topic": key})
            if category == "dangerous_dosing":
                meta["rationale"] = row["rationale"]
            records.append(make_record(f"{gid}:pos", "oc", 1, pos_text, dict(meta), gid))
            twin_meta = {**meta, "twin_of": f"{gid}:pos"}
            twin_meta.pop("rationale", None)
            records.append(make_record(f"{gid}:twin", "oc", 0, twin_text, twin_meta, gid))
    return records


# --------------------------------------------------------------------------- ol


def _hex(rng: random.Random, n: int) -> str:
    return f"{rng.getrandbits(4 * n):0{n}x}"


def _uuid(rng: random.Random) -> str:
    h = _hex(rng, 32)
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def _rfc1918(rng: random.Random) -> str:
    kind = rng.randrange(3)
    a, b, c = rng.randrange(256), rng.randrange(256), rng.randrange(1, 255)
    if kind == 0:
        return f"10.{a}.{b}.{c}"
    if kind == 1:
        return f"192.168.{b}.{c}"
    return f"172.{rng.randint(16, 31)}.{b}.{c}"


def _person(names: dict, rng: random.Random, avoid: str = "") -> dict:
    while True:
        sex = rng.choice(["male", "female"])
        first, last = rng.choice(names[f"first_{sex}"]), rng.choice(names["last"])
        if first != last and first not in avoid and last not in avoid:
            break
    year = rng.randint(1940, 2004)
    return {
        "name": f"{first} {last}",
        "age": str(2026 - year),
        "sex": sex,
        "dob": f"{rng.randint(1, 28):02d}/{rng.randint(1, 12):02d}/{year}",
        "phone": f"555-01{rng.randint(0, 99):02d}",
        "email": f"{first.lower()}.{last.lower()}{rng.randint(1, 99)}@example.com",
        "addr": f"{rng.randint(2, 98)} Example {rng.choice(['Street', 'Road', 'Lane'])}, "
        f"{rng.choice(names['cities'])}",
    }


def _slots(t: dict, rng: random.Random, patient: dict, clinician: str) -> dict:
    third = _person(t["names"], rng, avoid=patient["name"])
    return {
        "hex4": _hex(rng, 4),
        "hex8": _hex(rng, 8),
        "hex12": _hex(rng, 12),
        "hex20": _hex(rng, 20),
        "hex24": _hex(rng, 24),
        "hex32": _hex(rng, 32),
        "HEX9": _hex(rng, 9).upper(),
        "uuid": _uuid(rng),
        "uuid2": _uuid(rng),
        "ip": _rfc1918(rng),
        "clinician": clinician,
        **{f"patient_{k}": v for k, v in patient.items()},
        **{f"third_{k}": v for k, v in third.items()},
        "third_condition": rng.choice(t["names"]["conditions"]),
    }


def _leak_line(category: str, leak: dict, rng: random.Random, slots: dict) -> str:
    if category == "system_prompt":
        sp = leak["system_prompt"]
        return f"{rng.choice(sp['prefixes'])} {rng.choice(sp['bodies'])}"
    return rng.choice(leak[category]).format(**slots)


def build_ol(t: dict, *, per_category: int = OL_PER_CATEGORY) -> list[dict]:
    records: list[dict] = []
    seen: set[str] = set()
    leak = t["leakage"]
    for category in OL_CATEGORIES:
        for i in range(per_category):
            for attempt in range(50):
                rng = random.Random(f"{SEED}:ol:{category}:{i}:{attempt}")
                row = rng.choice(t["benign_note_rows"])
                frame = rng.choice(t["frames"])
                patient = _person(t["names"], rng)
                clinician = rng.choice(t["names"]["clinicians"])
                slots = _slots(t, rng, patient, clinician)
                date = f"2026-{rng.randint(1, 9):02d}-{rng.randint(1, 28):02d}"
                header = (
                    f"Consultation note: {patient['name']}, "
                    f"{patient['age']}-year-old {patient['sex']}; "
                    f"clinician {clinician}; {date}."
                )
                sections = {
                    "S": " ".join([row["S"], *rng.sample(t["filler"]["admin"], 2)]),
                    "O": _o_section(row, t["filler"], rng),
                    "A": row["A"],
                    "P": f"{row['P']} {_plan_tail(t['filler'], rng)}",
                }
                body = _render(frame, sections, lead=[header]).split("\n\n")
                at = rng.randint(2 if frame["title"] else 1, len(body))
                leak_line = _leak_line(category, leak, rng, slots)
                enc_line = rng.choice(leak["encounter_line"]).format(**slots)
                pos_text = "\n\n".join([*body[:at], leak_line, *body[at:]])
                twin_text = "\n\n".join([*body[:at], enc_line, *body[at:]])
                if pos_text not in seen and twin_text not in seen:
                    break
            else:  # pragma: no cover
                raise RuntimeError(f"cannot render a unique leakage note for {category} #{i}")
            seen.update((pos_text, twin_text))
            gid = f"ol:{category}:{i:03d}"
            meta = {
                "source": TEMPLATE_SOURCE,
                "category": category,
                "topic": row["topic"],
                "frame": frame["id"],
                "patient_name": patient["name"],
                "clinician": clinician,
            }
            pos_meta = {**meta, "inserted_line": leak_line}
            if category == "third_party_pii":
                pos_meta["third_name"] = slots["third_name"]
            twin_meta = {**meta, "inserted_line": enc_line, "twin_of": f"{gid}:pos"}
            records.append(make_record(f"{gid}:pos", "ol", 1, pos_text, pos_meta, gid))
            records.append(make_record(f"{gid}:twin", "ol", 0, twin_text, twin_meta, gid))
    return records


# --------------------------------------------------------------------------- on


def _mts_regions(texts: list[str], header: str) -> list[str]:
    """Concatenate one header's section texts (blank-line separated) into note-sized regions."""
    prefix = f"{header}:\n"
    regions: list[str] = []
    current: list[str] = []

    def size(parts: list[str]) -> int:
        return len(prefix) + len("\n\n".join(parts))

    for text in texts:
        if current and size([*current, text]) > NOTE_MAX and size(current) >= NOTE_MIN:
            regions.append(prefix + "\n\n".join(current))
            current = []
        current.append(text)
    if current:
        if size(current) >= NOTE_MIN:
            regions.append(prefix + "\n\n".join(current))
        elif regions and len(regions[-1]) + 2 + len("\n\n".join(current)) <= NOTE_MAX:
            regions[-1] = regions[-1] + "\n\n" + "\n\n".join(current)
    return regions


def build_on(cache: Path, *, aci_cap: int = ACI_CAP, mts_cap: int = MTS_CAP) -> list[dict]:
    rng = random.Random(f"{SEED}:on")
    aci: list[dict] = []
    seen: set[str] = set()
    for name in ACI_FILES:
        for row in _read_csv(cache / f"{name}.csv"):
            note = row["note"].strip()
            if not note or note in seen:
                continue
            seen.add(note)
            rid = f"on:aci:{name}:{row['encounter_id']}"
            meta = {
                "source": "ACI-Bench",
                "category": "clinical_note",
                "file": name,
                "encounter_id": row["encounter_id"],
            }
            aci.append(make_record(rid, "on", 0, note, meta, rid))
    groups: dict[str, list[str]] = defaultdict(list)
    for name in MTS_FILES:
        for row in _read_csv(cache / f"{name}.csv"):
            text = row["section_text"].strip()
            if text and text not in groups[row["section_header"]]:
                groups[row["section_header"]].append(text)
    mts: list[dict] = []
    for header, texts in groups.items():
        slug = re.sub(r"[^a-z0-9]+", "-", header.lower()).strip("-")
        for i, region in enumerate(_mts_regions(texts, header)):
            rid = f"on:mts:{slug}:{i:03d}"
            meta = {"source": "MTS-Dialog", "category": "clinical_note", "section_header": header}
            mts.append(make_record(rid, "on", 0, region, meta, rid))
    return sample(aci, aci_cap, rng) + sample(mts, mts_cap, rng)


# --------------------------------------------------------------------------- iu


def _one_line(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _lower_first(q: str) -> str:
    if q[:2] in ("I ", "I'") or (len(q) > 1 and q[1].isupper()):
        return q
    return q[:1].lower() + q[1:]


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()


def _iu_positive(
    spec: dict, bases: list[dict], rid: str, q: str, rng: random.Random, meta: dict
) -> dict:
    base = rng.choice(bases)
    payload = rng.choice(spec["addressees"]).format(q=_lower_first(q))
    carrier = rng.choice(spec["carriers"])
    text = embed_payload(base["text"], payload, carrier, rng, max_chars=IU_MAX_CHARS)
    meta = {
        "source": "Aegis-2.0 request embedded in a b1 base",
        **meta,
        "prompt_sha1": _sha1(q),
        "base_id": base["id"],
        "carrier": carrier,
        "payload_line": f"{carrier}: {payload}",
    }
    return make_record(rid, "iu", 1, text, meta, rid)


def _iu_topup(
    spec: dict,
    bases: list[dict],
    aegis_extra: dict[str, list[dict]],
    seen: set[str],
    existing: Counter,
) -> tuple[list[dict], dict]:
    """Top up thin criterion categories from REAL Aegis prompts of other splits (OD-43).

    Candidates are prompt-level unsafe rows whose violated categories include a mapped
    hazard, at most IU_MAX_REQUEST chars, and not an exact duplicate of any prompt already
    seen (s.jsonl, an earlier split, or another category). A deterministic sample tops each
    category up to ``target``; when fewer are available, all are used.
    """
    cfg = spec["topup"]
    records: list[dict] = []
    stats: dict[str, dict] = {}
    for category, hazards in cfg["hazards"].items():
        available: list[tuple[str, str, str, str, list[str]]] = []
        for split in cfg["splits"]:
            for rec in _usable_aegis(aegis_extra.get(split, []), split):
                if rec["label"] != 1:
                    continue
                cats = rec["meta"]["categories"]
                matched = next((c for c in cats if c in hazards), None)
                q = _one_line(rec["text"])
                if matched is None or q in seen or len(q) > IU_MAX_REQUEST:
                    continue
                seen.add(q)
                available.append((split, rec["id"].split(":")[-1], q, matched, cats))
        need = max(0, cfg["target"] - existing[category])
        chosen = sample(available, need, random.Random(f"{SEED}:iu:topup:{category}"))
        for split, row_id, q, hazard, cats in chosen:
            rid = f"iu:top:{split}:{row_id}"
            rng = random.Random(f"{SEED}:{rid}")
            meta = {
                "category": category,
                "scope": "criterion",
                "hazard": hazard,
                "categories": cats,
                "aegis_id": f"aegis:{split}:{row_id}",
                "aegis_split": split,
            }
            records.append(_iu_positive(spec, bases, rid, q, rng, meta))
        stats[category] = {
            "existing": existing[category],
            "available": len(available),
            "used": len(chosen),
            "total": existing[category] + len(chosen),
            "target": cfg["target"],
        }
    return records, stats


def build_iu(
    t: dict,
    guard: list[dict],
    bases: list[dict],
    aegis_extra: dict[str, list[dict]] | None = None,
) -> tuple[list[dict], dict, dict]:
    bases = sorted(bases, key=lambda r: r["id"])
    spec = t["iu_positive"]
    records: list[dict] = []
    excluded: Counter = Counter()
    for item in guard:
        if item["label"] != 1:
            continue
        hazard = item["meta"].get("hazard", "")
        q = _one_line(item["text"])
        if hazard not in spec["hazard_map"]:
            excluded[hazard] += 1
            continue
        if len(q) > IU_MAX_REQUEST:
            excluded["too_long"] += 1
            continue
        scope, judge_category = spec["hazard_map"][hazard]
        rng = random.Random(f"{SEED}:iu:pos:{item['id']}")
        rid = f"iu:pos:{item['id'].split(':')[-1]}"
        meta = {
            "category": judge_category,
            "scope": scope,
            "hazard": hazard,
            "aegis_id": item["id"],
            "aegis_split": item["meta"].get("aegis_split") or item["id"].split(":")[2],
        }
        records.append(_iu_positive(spec, bases, rid, q, rng, meta))
    seen_prompts = {_one_line(item["text"]) for item in guard}
    existing = Counter(r["meta"]["category"] for r in records)
    topup, topup_stats = _iu_topup(spec, bases, aegis_extra or {}, seen_prompts, existing)
    records += topup
    seen: set[str] = set()
    neg = t["iu_negative"]
    for scenario in neg["scenarios"]:
        for v in range(neg["variants_per_scenario"]):
            for attempt in range(50):
                rng = random.Random(f"{SEED}:iu:neg:{scenario['id']}:{v}:{attempt}")
                fill = {k: rng.choice(vals) for k, vals in sorted(scenario["slots"].items())}
                block = "\n".join(line.format(**fill) for line in scenario["lines"])
                base = rng.choice(bases)
                text = embed_payload(base["text"], block, "", rng, max_chars=IU_MAX_CHARS)
                if text not in seen:
                    break
            else:  # pragma: no cover
                raise RuntimeError(f"cannot render a unique negative for {scenario['id']}")
            seen.add(text)
            rid = f"iu:neg:{scenario['id']}:{v}"
            meta = {
                "source": "TASK-1049 S-4 clinical hard-negative template in a b1 base",
                "category": "clinical_hard_negative",
                "theme": scenario["theme"],
                "scenario": scenario["id"],
                "base_id": base["id"],
                "payload_line": block,
            }
            records.append(make_record(rid, "iu", 0, text, meta, rid))
    return records, dict(sorted(excluded.items())), topup_stats


# --------------------------------------------------------------------------- IO


def _read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def _windows(text: str) -> int:
    return sum(1 for _ in iter_windows(text, WINDOW_SIZE, WINDOW_OVERLAP))


def _counts(values) -> dict[str, int]:
    return {str(k): v for k, v in sorted(Counter(values).items())}


def write_sets(out: Path, sets: dict[str, list[dict]], extra: dict[str, dict]) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    ids: set[str] = set()
    manifest: dict = {"seed": SEED, "window": [WINDOW_SIZE, WINDOW_OVERLAP], "sets": {}}
    for name in SETS:
        records = sets[name]
        for rec in records:
            validate_record(rec)
            if rec["id"] in ids:
                raise ValueError(f"duplicate id {rec['id']}")
            ids.add(rec["id"])
        data = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records).encode()
        (out / f"{name}.jsonl").write_bytes(data)
        by_label: dict[str, dict[str, int]] = {}
        for label in sorted({r["label"] for r in records}):
            subset = [r for r in records if r["label"] == label]
            by_label[str(label)] = _counts(r["meta"]["category"] for r in subset)
        windows = {str(lab): 0 for lab in sorted({r["label"] for r in records})}
        for rec in records:
            windows[str(rec["label"])] += _windows(rec["text"])
        manifest["sets"][name] = {
            "file": f"{name}.jsonl",
            "records": len(records),
            "labels": _counts(r["label"] for r in records),
            "splits": _counts(r["split"] for r in records),
            "split_by_label": _counts(f"{r['label']}:{r['split']}" for r in records),
            "categories_by_label": by_label,
            "windows": sum(windows.values()),
            "windows_by_label": windows,
            "sha256": hashlib.sha256(data).hexdigest(),
            "licences": LICENCES[name],
            **extra.get(name, {}),
        }
    (out / "judge_sets_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return manifest


def build_all(cache: Path, guard_s: Path, b1: Path, templates: Path = TEMPLATES) -> tuple:
    t = load_templates(templates)
    aegis_extra = {
        split: fetch_split_rows(AEGIS, split, cache)
        for split in t["iu_positive"]["topup"]["splits"]
    }
    iu, excluded, topup = build_iu(t, _read_jsonl(guard_s), _read_jsonl(b1), aegis_extra)
    iu_pos = [r for r in iu if r["label"] == 1]
    on = build_on(cache)
    sets = {"oc": build_oc(t), "ol": build_ol(t), "on": on, "iu": iu}
    extra = {
        "oc": {"dosing_drugs": len({r["drug"] for r in t["dangerous_dosing"]})},
        "on": {"by_source": _counts(r["meta"]["source"] for r in on)},
        "iu": {
            "positive_scope": _counts(r["meta"]["scope"] for r in iu_pos),
            "positive_category_scope": _counts(
                f"{r['meta']['category']}:{r['meta']['scope']}" for r in iu_pos
            ),
            "positive_category_split": _counts(
                f"{r['meta']['category']}:{r['split']}" for r in iu_pos
            ),
            "positive_aegis_split": _counts(r["meta"]["aegis_split"] for r in iu_pos),
            "positive_hazard": _counts(r["meta"]["hazard"] for r in iu_pos),
            "excluded_unsafe": excluded,
            "topup": topup,
            "negative_scenarios": len({r["meta"]["scenario"] for r in iu if r["label"] == 0}),
            "negative_themes": _counts(r["meta"]["theme"] for r in iu if r["label"] == 0),
        },
    }
    return sets, extra


def main(argv: list[str] | None = None) -> dict:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--cache", type=Path, default=DATA / "cache")
    ap.add_argument("--guard-s", type=Path, default=DATA / "sets-guard" / "s.jsonl")
    ap.add_argument("--b1", type=Path, default=DATA / "sets" / "b1.jsonl")
    ap.add_argument("--templates", type=Path, default=TEMPLATES)
    args = ap.parse_args(argv)
    sets, extra = build_all(args.cache, args.guard_s, args.b1, args.templates)
    manifest = write_sets(args.out, sets, extra)
    for name, entry in manifest["sets"].items():
        print(f"{name}: {entry['records']} records, {entry['windows']} windows, {entry['labels']}")
    return manifest


if __name__ == "__main__":
    main()
