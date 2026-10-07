"""Deterministic synthetic consultations with gold PHI spans (TASK-1049 P-1).

Every document is assembled piece by piece, so a span's character offsets are exact by
construction (`text[start:end] == span["text"]` is asserted while building). One
*consultation* is a transcript plus a clinical note sharing one set of entities, which is
what the surrogate-consistency metric needs. Same seed -> byte-identical output.

    python -m pii_eval.generate --out <DIR> [--cache <DIR>] [--seed N]

Skeleton text (the non-PHI filler turns) comes from data already on the volume: the golden
set's `multi_encounter_v1.json` transcripts and ACI-bench dialogues (scrubbed of the names
they mention); with neither available a small built-in skeleton is used.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import re
import sys
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import date, timedelta
from pathlib import Path

from . import labels as L
from . import pools as P
from .verhoeff import verhoeff_check_digit

SEED = 1049
GENERATOR_VERSION = "1"
Skeleton = Sequence[tuple[str, str]]

_REPO = Path(__file__).resolve().parents[4]
GOLDEN_FIXTURE = _REPO / "apps/harness/src/harness/eval/golden/fixtures/multi_encounter_v1.json"
DEFAULT_CACHE = Path("/Volumes/aillusion/task-1049-data/cache")
ACI_FILES = (
    "train",
    "valid",
    "clinicalnlp_taskB_test1",
    "clinicalnlp_taskC_test2",
    "clef_taskC_test3",
)
DEFAULT_OUT = Path("/Volumes/aillusion/task-1049-data/pii")


def builtin_skeleton() -> Skeleton:
    return tuple(P.BUILTIN_SKELETON)


# ------------------------------------------------------------------------- skeleton
_FIX_I = re.compile(r"\bi(?=(?:'m|'ve|'ll|'d)?\b)")
_TITLED = re.compile(r"\b(?:dr|mr|mrs|ms|miss)\b\.?\s+[a-z]", re.IGNORECASE)
_GREETED = re.compile(r"\b(?:hi|hello|hey|morning|afternoon|evening)\s*,?\s+([a-z]{3,})\b")
_INTRO = re.compile(r"\b([a-z]{3,}) is an? \d{1,3}[- ]year[- ]old")
_NOT_NAMES = {"there", "everyone", "doctor", "again", "everybody", "folks", "sir", "ma", "how"}


def _sentence_case(text: str) -> str:
    text = re.sub(r"\s+([,.?!;:])", r"\1", text.strip())
    text = _FIX_I.sub("I", text)
    return text[:1].upper() + text[1:]


def _aci_turns(rows: Sequence[Mapping[str, str]]) -> list[tuple[str, str]]:
    """Name-scrubbed doctor/patient turns of ACI-bench dialogues, digit-free."""
    out: list[tuple[str, str]] = []
    for row in rows:
        turns: list[tuple[str, str]] = []
        for line in row["dialogue"].splitlines():
            m = re.match(r"\[(doctor|patient|guest_family)\]\s*(.*)", line)
            if m:
                turns.append(
                    ("Doctor" if m.group(1) == "doctor" else "Patient", m.group(2).strip())
                )
            elif turns and line.strip():
                turns[-1] = (turns[-1][0], f"{turns[-1][1]} {line.strip()}")
        names = {
            n
            for _, t in turns
            for n in (*_GREETED.findall(t.lower()), *_INTRO.findall(t.lower()))
            if n not in _NOT_NAMES
        }
        for speaker, text in turns[4:]:  # greetings sit in the first turns
            low = text.lower()
            if not 20 <= len(text) <= 260 or re.search(r"\d", text) or _TITLED.search(text):
                continue
            if any(re.search(rf"\b{re.escape(n)}\b", low) for n in names):
                continue
            out.append((speaker, _sentence_case(text)))
    return out


def _golden_turns(fixture: Path) -> list[tuple[str, str]]:
    data = json.loads(fixture.read_text())
    out = []
    for case in data["cases"]:
        for enc in case["transcript"]["encounters"]:
            for seg in enc["segments"]:
                text = " ".join(str(seg["text"]).split())
                if 12 <= len(text) <= 260 and not re.search(r"\d{4,}", text):
                    speaker = (
                        "Doctor" if str(seg["speaker"]).lower().startswith("doc") else "Patient"
                    )
                    out.append((speaker, text))
    return out


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_skeleton(
    cache_dir: Path | None = DEFAULT_CACHE, golden_fixture: Path | None = GOLDEN_FIXTURE
) -> tuple[Skeleton, list[dict]]:
    """Filler turns from the golden set and ACI-bench, with a sha256 per source file.

    Falls back to the built-in skeleton (sources == []) when neither is readable.
    `._*` files (exFAT metadata) are ignored.
    """
    turns: list[tuple[str, str]] = []
    sources: list[dict] = []
    if golden_fixture is not None and golden_fixture.exists():
        got = _golden_turns(golden_fixture)
        turns += got
        sources.append(
            {"path": golden_fixture.name, "sha256": _sha256(golden_fixture), "turns": len(got)}
        )
    if cache_dir is not None and cache_dir.exists():
        csv.field_size_limit(10**9)
        for name in ACI_FILES:
            path = cache_dir / f"{name}.csv"
            if path.name.startswith("._") or not path.exists():
                continue
            with path.open(newline="") as fh:
                got = _aci_turns(list(csv.DictReader(fh)))
            turns += got
            sources.append({"path": path.name, "sha256": _sha256(path), "turns": len(got)})
    if not turns:
        return builtin_skeleton(), []
    return tuple(dict.fromkeys(turns)), sources  # de-duplicated, order preserved


# ------------------------------------------------------------------ name partition
def _name_pools(seed: int, split: str) -> dict[str, list[str]]:
    """Per-role name pools. Tokens are partitioned between dev and test, so the two
    splits share no name even through a token that serves two roles (Thomas, Mathew)."""
    tokens = sorted({*P.FIRST_ML_M, *P.FIRST_ML_F, *P.FIRST_WEST, *P.LAST_ML, *P.LAST_WEST})
    random.Random(f"{seed}:name-partition").shuffle(tokens)
    mine = set(tokens[0::2] if split == "dev" else tokens[1::2])
    pick = lambda pool: [t for t in pool if t in mine]  # noqa: E731
    return {
        "first_ml": pick([*P.FIRST_ML_M, *P.FIRST_ML_F]),
        "first_west": pick(P.FIRST_WEST),
        "last_ml": pick(P.LAST_ML),
        "last_west": pick(P.LAST_WEST),
    }


# ------------------------------------------------------------------------ builder
class _Builder:
    def __init__(self) -> None:
        self.parts: list[str] = []
        self.pos = 0
        self.spans: list[dict] = []
        self.negatives: list[dict] = []

    def text(self, s: str) -> None:
        self.parts.append(s)
        self.pos += len(s)

    def span(self, label: str, value: str, entity: str) -> None:
        self.spans.append(
            {
                "label": label,
                "start": self.pos,
                "end": self.pos + len(value),
                "text": value,
                "entity": entity,
            }
        )
        self.text(value)

    def negative(self, kind: str, value: str) -> None:
        self.negatives.append(
            {"kind": kind, "start": self.pos, "end": self.pos + len(value), "text": value}
        )
        self.text(value)

    def build(self) -> tuple[str, list[dict], list[dict]]:
        text = "".join(self.parts)
        for item in (*self.spans, *self.negatives):
            assert text[item["start"] : item["end"]] == item["text"]
        return text, self.spans, self.negatives


# ------------------------------------------------------------------------ context
_DATE_FORMATS = (
    "{d:02d}/{m:02d}/{y}",
    "{d} {mon} {y}",
    "{mon} {d}, {y}",
    "{y}-{m:02d}-{d:02d}",
    "{d:02d}-{m:02d}-{y}",
)


def _fmt_date(day: date, fmt: str) -> str:
    return fmt.format(d=day.day, m=day.month, y=day.year, mon=P.MONTHS[day.month - 1])


def _digits(rng: random.Random, n: int, first: str = "0123456789") -> str:
    return rng.choice(first) + "".join(rng.choice("0123456789") for _ in range(n - 1))


def _aadhaar(rng: random.Random) -> str:
    body = _digits(rng, 11, "23456789")
    digits = body + verhoeff_check_digit(body)
    return rng.choice(
        (
            f"{digits[:4]} {digits[4:8]} {digits[8:]}",
            digits,
            f"{digits[:4]}-{digits[4:8]}-{digits[8:]}",
        )
    )


def _abha(rng: random.Random, first: str, last: str) -> str:
    if rng.random() < 0.3:
        return f"{first.lower()}.{last.lower()}@abdm"
    d = "91" + _digits(rng, 12)
    return rng.choice((f"{d[:2]}-{d[2:6]}-{d[6:10]}-{d[10:]}", d))


def _pan(rng: random.Random, last: str) -> str:
    letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    return (
        "".join(rng.choice(letters) for _ in range(3))
        + "P"
        + last[0].upper()
        + _digits(rng, 4)
        + rng.choice(letters)
    )


def _phone(rng: random.Random, indian: bool) -> str:
    if not indian:
        return f"+1 555 {_digits(rng, 4)} {_digits(rng, 4)}"
    n = _digits(rng, 10, "6789")
    return rng.choice(
        (
            f"+91 {n[:5]} {n[5:]}",
            f"+91-{n}",
            f"0{n}",
            f"{n[:5]} {n[5:]}",
            f"0484 {_digits(rng, 7, '2345')}",
        )
    )


class _Ctx:
    """The entities of ONE consultation, fixed before any text is written."""

    def __init__(self, rng: random.Random, pools: Mapping[str, list[str]], index: int) -> None:
        self.rng = rng
        self.indian = rng.random() < 0.72
        first = pools["first_ml"] if self.indian else pools["first_west"]
        last = pools["last_ml"] if self.indian else pools["last_west"]
        self.p_first, self.p_last = rng.choice(first), rng.choice(last)
        shares_surname = rng.random() < 0.5
        r_first = rng.choice([n for n in first if n != self.p_first])
        self.r_first = r_first
        self.r_last = (
            self.p_last if shares_surname else rng.choice([n for n in last if n != self.p_last])
        )
        taken = {self.p_first, self.p_last, self.r_first, self.r_last}
        self.c_first = rng.choice([n for n in first if n not in taken])
        self.c_last = rng.choice([n for n in last if n not in taken | {self.c_first}])
        self.relation, self.relation_ml = rng.choice(P.RELATIONS)

        self.svc = date(2025, 1, 1) + timedelta(days=rng.randint(0, 637))
        # every 7th consultation is a patient over 89 (deterministic, so the label is never absent)
        self.age = rng.randint(90, 101) if index % 7 == 3 else rng.randint(18, 89)
        self.dob = self.svc - timedelta(days=self.age * 365 + rng.randint(0, 364))
        self.fmt_dob, self.fmt_svc = rng.choice(_DATE_FORMATS), rng.choice(_DATE_FORMATS)

        has = lambda p: rng.random() < p  # noqa: E731
        self.has = {
            "clinician": has(0.9),
            "dob": has(0.7),
            "svc": has(0.6),
            "phone": has(0.75),
            "phone_rel": has(0.3),
            "email": has(0.5),
            "address": has(0.65),
            "mrn": has(0.7),
            "insurance": has(0.5),
            "url": has(0.3),
            "ip": has(0.2),
            "device": has(0.3),
            "aadhaar": has(0.5 if self.indian else 0.0),
            "abha": has(0.4 if self.indian else 0.0),
            "pan": has(0.3 if self.indian else 0.0),
            "relative": has(0.6),
        }
        year = self.svc.year
        self.values = {
            "patient": f"{self.p_first} {self.p_last}",
            "dob": _fmt_date(self.dob, self.fmt_dob),
            "svc": _fmt_date(self.svc, self.fmt_svc),
            "phone": _phone(rng, self.indian),
            "phone_rel": _phone(rng, self.indian),
            "email": rng.choice(
                (
                    f"{self.p_first.lower()}.{self.p_last.lower()}{rng.randint(1, 99)}",
                    f"{self.p_first.lower()}{self.p_last[0].lower()}{rng.randint(10, 9999)}",
                )
            )
            + "@"
            + rng.choice(P.EMAIL_DOMAINS),
            "mrn": rng.choice(
                (
                    _digits(rng, 7, "123456789"),
                    f"MRN-{_digits(rng, 6, '123456789')}",
                    f"KMC-{year}-{_digits(rng, 6)}",
                )
            ),
            "insurance": rng.choice(
                (
                    f"POL-IN-{_digits(rng, 8, '123456789')}",
                    f"PMJAY-KL-{_digits(rng, 8, '123456789')}",
                    f"ECHS{_digits(rng, 7, '123456789')}",
                )
            ),
            "url": f"https://{rng.choice(P.URL_HOSTS)}/records/{rng.randint(16**5, 16**6):x}",
            "ip": ".".join(
                str(rng.randint(11, 223) if i == 0 else rng.randint(1, 254)) for i in range(4)
            ),
            "device": rng.choice(
                (
                    f"PM-{_digits(rng, 6, '123456789')}-X",
                    f"GL-{_digits(rng, 5, '123456789')}",
                    f"SN{_digits(rng, 7, '123456789')}",
                    _digits(rng, 15, "123456789"),
                )
            ),
            "aadhaar": _aadhaar(rng),
            "abha": _abha(rng, self.p_first, self.p_last),
            "pan": _pan(rng, self.p_last),
        }
        if self.indian:
            pin = rng.choice(("67", "68", "69")) + _digits(rng, 4)
            self.values["address"] = (
                f"{rng.choice(('Flat 4B', 'House 12/345', 'TC 25/1234', 'Door No 7'))}, {rng.choice(P.BUILDINGS_IN)}, "
                f"{rng.choice(P.STREETS_IN)}, {rng.choice(P.CITIES_IN)}"
            )
        else:
            pin = _digits(rng, 6, "123456789")
            self.values["address"] = (
                f"{rng.randint(10, 9999)} {rng.choice(P.STREETS_WEST)}, {rng.choice(P.CITIES_WEST)}"
            )
        self.values["pin"] = pin


_SPAN_SLOTS = {
    "patient_full": (L.PATIENT_NAME, "patient", lambda c: f"{c.p_first} {c.p_last}"),
    "patient_first": (L.PATIENT_NAME, "patient", lambda c: c.p_first),
    "patient_last": (L.PATIENT_NAME, "patient", lambda c: c.p_last),
    "relative_full": (L.RELATIVE_NAME, "relative", lambda c: f"{c.r_first} {c.r_last}"),
    "relative_first": (L.RELATIVE_NAME, "relative", lambda c: c.r_first),
    "clinician_full": (L.CLINICIAN, "clinician", lambda c: f"{c.c_first} {c.c_last}"),
    "clinician_last": (L.CLINICIAN, "clinician", lambda c: c.c_last),
    "dob": (L.DATE, "dob", lambda c: c.values["dob"]),
    "svc_date": (L.DATE, "svc", lambda c: c.values["svc"]),
    "phone": (L.PHONE, "phone", lambda c: c.values["phone"]),
    "phone_rel": (L.PHONE, "phone_rel", lambda c: c.values["phone_rel"]),
    "email": (L.EMAIL, "email", lambda c: c.values["email"]),
    "address": (L.ADDRESS, "address", lambda c: c.values["address"]),
    "pin": (L.PIN_CODE, "pin", lambda c: c.values["pin"]),
    "mrn": (L.MRN, "mrn", lambda c: c.values["mrn"]),
    "insurance": (L.INSURANCE_ID, "insurance", lambda c: c.values["insurance"]),
    "url": (L.URL, "url", lambda c: c.values["url"]),
    "ip": (L.IP_ADDRESS, "ip", lambda c: c.values["ip"]),
    "device": (L.DEVICE_ID, "device", lambda c: c.values["device"]),
    "aadhaar": (L.AADHAAR, "aadhaar", lambda c: c.values["aadhaar"]),
    "abha": (L.ABHA, "abha", lambda c: c.values["abha"]),
    "pan": (L.PAN, "pan", lambda c: c.values["pan"]),
}
_SLOT = re.compile(r"\{(\w+)\}")


def _interval(rng: random.Random, ml: bool) -> str:
    n = rng.choice(sorted(P.NUMBER_WORDS))
    k = rng.randrange(3)
    if ml:
        unit = P.ML_UNITS[k]
        return rng.choice(
            (
                f"{rng.randint(2, 9)} {unit}",
                f"{P.ML_NUMBERS[n]} {unit}",
                f"{rng.randint(2015, 2024)} muthal",
            )
        )
    unit = P.EN_UNITS[k]
    return rng.choice(
        (
            f"for {rng.randint(2, 9)} {unit}",
            f"for {P.NUMBER_WORDS[n]} {unit}",
            f"since {rng.randint(2015, 2024)}",
            f"about {P.NUMBER_WORDS[n]} {unit} ago",
        )
    )


def _render(b: _Builder, ctx: _Ctx, template: str) -> None:
    rng = ctx.rng
    cursor = 0
    for m in _SLOT.finditer(template):
        b.text(template[cursor : m.start()])
        cursor = m.end()
        slot = m.group(1)
        if slot in _SPAN_SLOTS:
            label, entity, fn = _SPAN_SLOTS[slot]
            b.span(label, fn(ctx), entity)
        elif slot == "age":
            if ctx.age >= 90:
                b.span(L.AGE_OVER_89, str(ctx.age), "age")
            else:
                b.negative("age_under_90", str(ctx.age))
        elif slot == "disease":
            b.negative("eponym_disease", rng.choice(P.DISEASES))
        elif slot == "anatomy":
            b.negative("eponym_anatomy", rng.choice(P.ANATOMY))
        elif slot == "drug":
            b.negative("drug_name", rng.choice(P.DRUGS))
        elif slot == "dose":
            b.negative("dose_number", rng.choice(P.DOSES))
        elif slot == "vital":
            b.negative("vital_sign", rng.choice(P.VITALS))
        elif slot == "lot":
            digits = _digits(rng, 12, "123456789")
            while _is_aadhaar_valid(digits):  # a lot number must not be a valid Aadhaar
                digits = _digits(rng, 12, "123456789")
            b.negative("lot_number", digits)
        elif slot == "interval":
            b.negative("clinical_interval", _interval(rng, False))
        elif slot == "interval_ml":
            b.negative("clinical_interval", _interval(rng, True))
        elif slot == "relation":
            b.text(ctx.relation)
        elif slot == "relation_ml":
            b.text(ctx.relation_ml)
        elif slot == "symptom_ml":
            b.text(rng.choice(P.SYMPTOMS_ML))
        else:
            raise KeyError(slot)
    b.text(template[cursor:])


def _is_aadhaar_valid(digits: str) -> bool:
    from .verhoeff import verhoeff_valid

    return digits[0] in "23456789" and verhoeff_valid(digits)


# ---------------------------------------------------------------------- scripts
Script = list[tuple[str, str]]
_EN: dict[str, list[Script]] = {
    "intro": [
        [
            ("Doctor", "Good morning. Am I speaking with {patient_full}?"),
            ("Patient", "Yes, that is me."),
        ],
        [("Doctor", "Hello {patient_first}, please take a seat."), ("Patient", "Thank you.")],
        [
            ("Patient", "Hello, I am {patient_full}, I have an appointment."),
            ("Doctor", "Yes, come in."),
        ],
    ],
    "clinician": [
        [("Doctor", "I am Dr. {clinician_full} and I will be looking after you today.")],
        [("Patient", "Thank you, Dr. {clinician_last}."), ("Doctor", "Let us begin.")],
    ],
    "dob": [[("Doctor", "Can you confirm your date of birth?"), ("Patient", "It is {dob}.")]],
    "svc": [[("Doctor", "I see you were last seen on {svc_date}.")]],
    "age": [
        [("Doctor", "How old are you now?"), ("Patient", "I am {age} years old.")],
        [("Doctor", "{patient_first} is {age} years old and presents for review.")],
    ],
    "phone": [
        [
            ("Doctor", "What is the best number to reach you on?"),
            ("Patient", "Call me on {phone}."),
        ],
        [("Patient", "My mobile number is {phone}, please use that.")],
    ],
    "phone_rel": [
        [("Doctor", "And a number for a family member?"), ("Patient", "You can try {phone_rel}.")]
    ],
    "email": [
        [("Doctor", "Shall we email the results?"), ("Patient", "Yes, send them to {email}.")]
    ],
    "address": [
        [("Doctor", "Can you confirm your address?"), ("Patient", "{address}, PIN {pin}.")],
        [("Patient", "I live at {address}. The postal code is {pin}.")],
    ],
    "mrn": [
        [("Doctor", "Your MRN is {mrn}, is that right?"), ("Patient", "Yes.")],
        [("Doctor", "I have UHID {mrn} on the file.")],
    ],
    "insurance": [
        [
            ("Doctor", "Which insurance do you hold?"),
            ("Patient", "My policy number is {insurance}."),
        ]
    ],
    "url": [[("Doctor", "You can view the report at {url} once it is ready.")]],
    "device": [
        [
            ("Doctor", "Please read me the serial number on the device."),
            ("Patient", "It says {device}."),
        ]
    ],
    "aadhaar": [
        [("Doctor", "I need your Aadhaar for the registration."), ("Patient", "It is {aadhaar}.")]
    ],
    "abha": [[("Doctor", "Do you have an ABHA number?"), ("Patient", "Yes, ABHA {abha}.")]],
    "pan": [[("Doctor", "For the billing I need your PAN."), ("Patient", "It is {pan}.")]],
    "relative": [
        [
            ("Doctor", "Who has come with you today?"),
            ("Patient", "My {relation}, {relative_full}."),
        ],
        [("Patient", "My {relation} {relative_first} noticed it first.")],
    ],
}
_ML: dict[str, list[Script]] = {
    "intro": [
        [
            ("Doctor", "Namaskaram, {patient_full} alle?"),
            ("Patient", "Athe doctor, njan {patient_full} aanu."),
        ],
        [("Doctor", "Irikku {patient_first}, entha prashnam?")],
    ],
    "clinician": [
        [
            ("Doctor", "Ente peru Dr. {clinician_full}. Parayu."),
            ("Patient", "Sheri Dr. {clinician_last}."),
        ]
    ],
    "dob": [[("Doctor", "Date of birth ethaanu?"), ("Patient", "{dob} aanu doctor.")]],
    "svc": [[("Doctor", "Kazhinja thavana {svc_date} il aanu vannathu alle?")]],
    "age": [[("Doctor", "Vayassu ethra aayi?"), ("Patient", "{age} aayi doctor.")]],
    "phone": [
        [
            ("Doctor", "Phone number onnu parayamo?"),
            ("Patient", "{phone} aanu, ithu thanne WhatsApp um."),
        ]
    ],
    "phone_rel": [[("Patient", "Veettil vilikkanamenkil {phone_rel} il vilikku.")]],
    "email": [[("Patient", "Report email ayakkamo, {email} il.")]],
    "address": [[("Doctor", "Evideya veedu?"), ("Patient", "{address}, PIN {pin}.")]],
    "mrn": [[("Doctor", "File number {mrn} aanu alle?"), ("Patient", "Athe.")]],
    "insurance": [[("Patient", "Insurance policy number {insurance} aanu.")]],
    "url": [[("Doctor", "Report {url} il kittum.")]],
    "device": [
        [("Doctor", "Device nte serial number nokku."), ("Patient", "{device} ennanu kaanunnathu.")]
    ],
    "aadhaar": [[("Doctor", "Aadhaar number venam."), ("Patient", "{aadhaar} aanu.")]],
    "abha": [[("Doctor", "ABHA number undo?"), ("Patient", "Undu, {abha}.")]],
    "pan": [[("Patient", "PAN {pan} aanu doctor.")]],
    "relative": [
        [
            ("Doctor", "Koode aaraanu vannathu?"),
            ("Patient", "Ente {relation_ml} {relative_full} aanu."),
        ],
        [("Patient", "Ente {relation_ml} {relative_first} aanu ithu aadyam kandathu.")],
    ],
}
_NEG_EN: list[Script] = [
    [
        ("Doctor", "Any history of {disease} in the family?"),
        ("Patient", "My {relation} had {disease}."),
    ],
    [("Doctor", "The scan shows changes near the {anatomy}.")],
    [("Doctor", "I am prescribing {drug} {dose} twice daily.")],
    [("Patient", "I have had this pain {interval}.")],
    [("Doctor", "Your blood pressure is {vital} today."), ("Patient", "Is that high?")],
    [("Patient", "I take {drug} {dose} and also {drug} {dose}.")],
    [("Doctor", "When did the cough start?"), ("Patient", "It began {interval}.")],
    [("Doctor", "The vial batch reads {lot}, that is the manufacturer's lot, not yours.")],
    [("Doctor", "We should rule out {disease} given the tremor.")],
    [("Doctor", "Take {drug} {dose} after food and review {interval}.")],
]
_NEG_ML: list[Script] = [
    [("Patient", "Enikku {symptom_ml} und, {interval_ml} aayi.")],
    [("Doctor", "{drug} {dose} randu neram kazhikkanam.")],
    [("Patient", "Ente {relation_ml} nu {disease} und.")],
    [("Doctor", "Scan il {anatomy} nte aduthu maattam kaanunnu.")],
    [("Doctor", "Pressure {vital} aanu, kuzhappam illa.")],
    [("Patient", "{interval_ml} aayi {drug} kazhikkunnu.")],
]
_ALWAYS_FIRST = ("intro", "clinician")
_NOTE_AGE = [
    "{patient_first} is a {age}-year-old with ongoing symptoms {interval}.",
    "Patient {patient_last} is {age} years old and reports symptoms {interval}.",
]
_NOTE_NEG = [
    "Past history includes {disease}.",
    "Started on {drug} {dose}, review {interval}.",
    "Examination of the {anatomy} was unremarkable.",
    "Vitals: {vital}.",
    "Continue {drug} {dose}.",
]


def _dialogue(
    ctx: _Ctx, skeleton: Skeleton, n_fill: int, mlen: bool
) -> tuple[str, list[dict], list[dict]]:
    rng = ctx.rng
    scripts = _ML if mlen else _EN
    b = _Builder()

    def present(key: str) -> bool:
        return key in ("intro", "age") or ctx.has.get(key if key != "pin" else "address", False)

    head: list[Script] = [rng.choice(scripts[k]) for k in _ALWAYS_FIRST if present(k)]
    body: list[Script] = [
        rng.choice(s) for k, s in scripts.items() if k not in _ALWAYS_FIRST and present(k)
    ]
    body += [rng.choice(_NEG_ML if mlen else _NEG_EN) for _ in range(rng.randint(3, 8))]
    filler: list[Script] = []
    pool = list(skeleton) + (list(P.MANGLISH_FILLER) * 2 if mlen else [])
    placed = 0
    while placed < n_fill:
        run = rng.randint(1, 4)
        filler.append([rng.choice(pool) for _ in range(run)])
        placed += run
    blocks = body + filler
    rng.shuffle(blocks)
    for script in (*head, *blocks):
        for speaker, template in script:
            b.text(f"{speaker}: ")
            _render(b, ctx, template)
            b.text("\n")
    return b.build()


def _note(ctx: _Ctx, skeleton: Skeleton) -> tuple[str, list[dict], list[dict]]:
    rng = ctx.rng
    b = _Builder()
    lines: list[str] = ["CLINICAL NOTE"]
    lines.append("Patient: {patient_full}" + ("    DOB: {dob}" if ctx.has["dob"] else ""))
    if ctx.has["mrn"]:
        lines.append("MRN: {mrn}" + ("    Insurance: {insurance}" if ctx.has["insurance"] else ""))
    elif ctx.has["insurance"]:
        lines.append("Insurance: {insurance}")
    if ctx.has["address"]:
        lines.append("Address: {address} - {pin}")
    contact = [
        t for t, k in (("Phone: {phone}", "phone"), ("Email: {email}", "email")) if ctx.has[k]
    ]
    if contact:
        lines.append("    ".join(contact))
    ids = [
        t
        for t, k in (
            ("Aadhaar: {aadhaar}", "aadhaar"),
            ("ABHA: {abha}", "abha"),
            ("PAN: {pan}", "pan"),
        )
        if ctx.has[k]
    ]
    if ids:
        lines.append("    ".join(ids))
    if ctx.has["device"]:
        lines.append("Implant/device serial: {device}")
    if ctx.has["ip"]:
        lines.append("Portal login recorded from IP {ip}.")
    if ctx.has["url"]:
        lines.append("Report link: {url}")
    seen = "Seen" + (" by Dr. {clinician_full}" if ctx.has["clinician"] else "")
    lines.append(seen + (" on {svc_date}." if ctx.has["svc"] else "."))
    lines.append("")
    lines.append(rng.choice(_NOTE_AGE))
    lines += rng.sample(_NOTE_NEG, k=rng.randint(2, 4))
    lines += rng.sample(P.NOTE_SENTENCES, k=rng.randint(2, 4))
    if ctx.has["relative"]:
        tail = "Accompanied by {relation}, {relative_full}"
        lines.append(tail + (" (contact {phone_rel})." if ctx.has["phone_rel"] else "."))
    for line in lines:
        _render(b, ctx, line)
        b.text("\n")
    return b.build()


# ------------------------------------------------------------------------- driver
def _consultation(split: str, i: int, seed: int, pools: Mapping, skeleton: Skeleton) -> list[dict]:
    rng = random.Random(f"{seed}:{split}:{i}")
    ctx = _Ctx(rng, pools, i)
    mlen = rng.random() < 0.45
    long_doc = i % 8 == 5
    n_fill = rng.randint(110, 230) if long_doc else rng.randint(14, 34)
    cid = f"{split}-{i:04d}"
    docs = []
    for kind, builder in (
        ("dialogue_mlen" if mlen else "dialogue", lambda: _dialogue(ctx, skeleton, n_fill, mlen)),
        ("note", lambda: _note(ctx, skeleton)),
    ):
        text, spans, negatives = builder()
        docs.append(
            {
                "id": f"{cid}-{'dialogue' if kind != 'note' else 'note'}",
                "consultation_id": cid,
                "split": split,
                "kind": kind,
                "text": text,
                "spans": spans,
                "negatives": negatives,
            }
        )
    return docs


def generate_dataset(
    *, seed: int = SEED, n_dev: int = 40, n_test: int = 80, skeleton: Skeleton | None = None
) -> dict[str, list[dict]]:
    skeleton = skeleton or builtin_skeleton()
    out: dict[str, list[dict]] = {}
    for split, n in (("dev", n_dev), ("test", n_test)):
        pools = _name_pools(seed, split)
        out[split] = [d for i in range(n) for d in _consultation(split, i, seed, pools, skeleton)]
    return out


def dataset_stats(dataset: Mapping[str, Sequence[Mapping]]) -> dict:
    stats: dict[str, dict] = {}
    for split, docs in dataset.items():
        labels = Counter(s["label"] for d in docs for s in d["spans"])
        kinds = Counter(n["kind"] for d in docs for n in d["negatives"])
        lengths = [len(d["text"]) for d in docs]
        stats[split] = {
            "documents": len(docs),
            "consultations": len({d["consultation_id"] for d in docs}),
            "document_kinds": dict(sorted(Counter(d["kind"] for d in docs).items())),
            "characters": sum(lengths),
            "max_chars": max(lengths, default=0),
            "docs_over_2000_chars": sum(1 for n in lengths if n > 2000),
            "labels": dict(sorted(labels.items())),
            "negative_kinds": dict(sorted(kinds.items())),
        }
    return stats


def write_dataset(
    out_dir: Path,
    *,
    seed: int = SEED,
    n_dev: int = 40,
    n_test: int = 80,
    skeleton: Skeleton | None = None,
    skeleton_sources: Sequence[dict] = (),
) -> dict:
    skeleton = skeleton or builtin_skeleton()
    dataset = generate_dataset(seed=seed, n_dev=n_dev, n_test=n_test, skeleton=skeleton)
    out_dir.mkdir(parents=True, exist_ok=True)
    files: dict[str, dict] = {}
    for split, docs in dataset.items():
        name = f"{split}.jsonl"
        data = "".join(
            json.dumps(d, sort_keys=True, ensure_ascii=False) + "\n" for d in docs
        ).encode()
        (out_dir / name).write_bytes(data)
        files[name] = {
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "records": len(docs),
        }
    manifest = {
        "generator": "pii_eval.generate",
        "generator_version": GENERATOR_VERSION,
        "seed": seed,
        "consultations": {"dev": n_dev, "test": n_test},
        "window_geometry": {"size": 2000, "overlap": 256},
        "skeleton": {
            "turns": len(skeleton),
            "builtin": not skeleton_sources,
            "sources": list(skeleton_sources),
        },
        "files": files,
        "stats": dataset_stats(dataset),
        "caveats": [
            "Synthetic. Malayalam-English utterances are templated Latin-script code-switch and "
            "have not been reviewed by a native speaker.",
            "ACI-bench filler turns are scrubbed of the names their dialogue greets; a residual "
            "unlabelled name is possible and would show up as a false positive, never as a leak.",
            "Dates of birth and service dates are DATE; a year alone ('since 2019') is a "
            "clinical-interval hard negative.",
        ],
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    p.add_argument("--seed", type=int, default=SEED)
    p.add_argument("--n-dev", type=int, default=40)
    p.add_argument("--n-test", type=int, default=80)
    p.add_argument("--builtin-skeleton", action="store_true", help="ignore the volume data")
    a = p.parse_args(argv)
    if a.builtin_skeleton:
        skeleton, sources = builtin_skeleton(), []
    else:
        skeleton, sources = load_skeleton(a.cache)
    manifest = write_dataset(
        a.out,
        seed=a.seed,
        n_dev=a.n_dev,
        n_test=a.n_test,
        skeleton=skeleton,
        skeleton_sources=sources,
    )
    print(json.dumps({k: manifest[k] for k in ("files", "skeleton")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
