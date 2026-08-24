"""The PLATFORM BASELINE clinical taxonomy, as a test fixture (TASK-799 lane G).

`apps/nlp` ships no clinical taxonomy of its own any more: the ontology
vocabulary, vitals plausibility bands, ConText/NegEx triggers and the NER
contract all arrive per request on `clinical_taxonomy`, resolved by the gateway
from `AiModel._metadata.clinicalTaxonomy` on the row `nlp.ner` selects.

This module holds the SAME values the seed writes onto the `medical-ner` row
(`packages/database/src/prisma/db_main/seed/ai-models/nlp.ts`), so the suites
that assert real clinical behaviour ("metformin resolves to RxNorm 6809",
"138/88 is a plausible BP") keep asserting it — but now against an INJECTED
taxonomy, which is the actual contract. `test_task799_lane_g_taxonomy.py` covers
the other half: that changing the injected value changes the answer, and that an
absent one disables the pass rather than falling back to a literal.
"""

from __future__ import annotations

from typing import Any

from nlp.schemas.clinical_taxonomy import ClinicalTaxonomy

#: Verbatim transcription of the seeded `clinicalTaxonomy` blob.
SEEDED_CLINICAL_TAXONOMY_JSON: dict[str, Any] = {
    "tokenClassifier": {
        "aggregationStrategy": "simple",
        "ignoreLabels": [
            "O"
        ],
        "assertionEnabled": True
    },
    "linker": {
        "enabled": True,
        "confidenceFloor": 0.0,
        "vocabulary": [
            {
                "aliases": [
                    "metformin"
                ],
                "umls_cui": "C0025598",
                "rxnorm_code": "6809"
            },
            {
                "aliases": [
                    "aspirin",
                    "acetylsalicylic acid"
                ],
                "umls_cui": "C0004057",
                "rxnorm_code": "1191"
            },
            {
                "aliases": [
                    "amoxicillin"
                ],
                "umls_cui": "C0002645",
                "rxnorm_code": "723"
            },
            {
                "aliases": [
                    "amlodipine"
                ],
                "umls_cui": "C0051696",
                "rxnorm_code": "17767"
            },
            {
                "aliases": [
                    "lisinopril"
                ],
                "umls_cui": "C0065374",
                "rxnorm_code": "29046"
            },
            {
                "aliases": [
                    "metoprolol"
                ],
                "umls_cui": "C0025859",
                "rxnorm_code": "6918"
            },
            {
                "aliases": [
                    "atorvastatin"
                ],
                "umls_cui": "C0286651",
                "rxnorm_code": "83367"
            },
            {
                "aliases": [
                    "ibuprofen"
                ],
                "umls_cui": "C0020740",
                "rxnorm_code": "5640"
            },
            {
                "aliases": [
                    "insulin"
                ],
                "umls_cui": "C0021641",
                "rxnorm_code": "5856"
            },
            {
                "aliases": [
                    "warfarin"
                ],
                "umls_cui": "C0043031",
                "rxnorm_code": "11289"
            },
            {
                "aliases": [
                    "omeprazole"
                ],
                "umls_cui": "C0028978",
                "rxnorm_code": "7646"
            },
            {
                "aliases": [
                    "albuterol",
                    "salbutamol"
                ],
                "umls_cui": "C0001927",
                "rxnorm_code": "435"
            },
            {
                "aliases": [
                    "prednisone"
                ],
                "umls_cui": "C0032952",
                "rxnorm_code": "8640"
            },
            {
                "aliases": [
                    "furosemide"
                ],
                "umls_cui": "C0016860",
                "rxnorm_code": "4603"
            },
            {
                "aliases": [
                    "pneumonia"
                ],
                "umls_cui": "C0032285",
                "snomed_code": "233604007",
                "icd_code": "J18.9"
            },
            {
                "aliases": [
                    "hypertension",
                    "high blood pressure"
                ],
                "umls_cui": "C0020538",
                "snomed_code": "38341003",
                "icd_code": "I10"
            },
            {
                "aliases": [
                    "type 2 diabetes",
                    "type ii diabetes",
                    "t2dm"
                ],
                "umls_cui": "C0011860",
                "snomed_code": "44054006",
                "icd_code": "E11.9"
            },
            {
                "aliases": [
                    "asthma"
                ],
                "umls_cui": "C0004096",
                "snomed_code": "195967001",
                "icd_code": "J45.909"
            },
            {
                "aliases": [
                    "copd",
                    "chronic obstructive pulmonary disease"
                ],
                "umls_cui": "C0024117",
                "snomed_code": "13645005",
                "icd_code": "J44.9"
            },
            {
                "aliases": [
                    "covid-19",
                    "covid",
                    "covid 19"
                ],
                "umls_cui": "C5203670",
                "snomed_code": "840539006",
                "icd_code": "U07.1"
            },
            {
                "aliases": [
                    "myocardial infarction",
                    "heart attack"
                ],
                "umls_cui": "C0027051",
                "snomed_code": "22298006",
                "icd_code": "I21.9"
            },
            {
                "aliases": [
                    "sepsis"
                ],
                "umls_cui": "C0243026",
                "snomed_code": "91302008",
                "icd_code": "A41.9"
            },
            {
                "aliases": [
                    "anemia",
                    "anaemia"
                ],
                "umls_cui": "C0002871",
                "snomed_code": "271737000",
                "icd_code": "D64.9"
            },
            {
                "aliases": [
                    "headache",
                    "cephalalgia"
                ],
                "umls_cui": "C0018681",
                "snomed_code": "25064002",
                "icd_code": "R51.9"
            },
            {
                "aliases": [
                    "fever",
                    "pyrexia"
                ],
                "umls_cui": "C0015967",
                "snomed_code": "386661006",
                "icd_code": "R50.9"
            },
            {
                "aliases": [
                    "chest pain"
                ],
                "umls_cui": "C0008031",
                "snomed_code": "29857009",
                "icd_code": "R07.9"
            },
            {
                "aliases": [
                    "cough"
                ],
                "umls_cui": "C0010200",
                "snomed_code": "49727002",
                "icd_code": "R05.9"
            },
            {
                "aliases": [
                    "nausea"
                ],
                "umls_cui": "C0027497",
                "snomed_code": "422587007",
                "icd_code": "R11.0"
            },
            {
                "aliases": [
                    "shortness of breath",
                    "dyspnea",
                    "dyspnoea",
                    "sob"
                ],
                "umls_cui": "C0013404",
                "snomed_code": "267036007",
                "icd_code": "R06.02"
            },
            {
                "aliases": [
                    "fatigue"
                ],
                "umls_cui": "C0015672",
                "snomed_code": "84229001",
                "icd_code": "R53.83"
            },
            {
                "aliases": [
                    "dizziness"
                ],
                "umls_cui": "C0012833",
                "snomed_code": "404640003",
                "icd_code": "R42"
            },
            {
                "aliases": [
                    "hemoglobin a1c",
                    "hba1c",
                    "a1c",
                    "glycated hemoglobin"
                ],
                "umls_cui": "C0202054",
                "loinc_code": "4548-4"
            },
            {
                "aliases": [
                    "glucose",
                    "blood glucose"
                ],
                "umls_cui": "C0202041",
                "loinc_code": "2345-7"
            },
            {
                "aliases": [
                    "creatinine"
                ],
                "umls_cui": "C0201975",
                "loinc_code": "2160-0"
            },
            {
                "aliases": [
                    "hemoglobin",
                    "haemoglobin",
                    "hgb"
                ],
                "umls_cui": "C0518015",
                "loinc_code": "718-7"
            },
            {
                "aliases": [
                    "potassium"
                ],
                "umls_cui": "C0202194",
                "loinc_code": "2823-3"
            },
            {
                "aliases": [
                    "white blood cell count",
                    "wbc"
                ],
                "umls_cui": "C0023508",
                "loinc_code": "6690-2"
            },
            {
                "aliases": [
                    "chest x-ray",
                    "chest xray",
                    "cxr"
                ],
                "umls_cui": "C0039985",
                "snomed_code": "399208008"
            },
            {
                "aliases": [
                    "electrocardiogram",
                    "ecg",
                    "ekg"
                ],
                "umls_cui": "C0013798",
                "snomed_code": "29303009"
            },
            {
                "aliases": [
                    "mri",
                    "magnetic resonance imaging"
                ],
                "umls_cui": "C0024485",
                "snomed_code": "113091000"
            }
        ]
    },
    "vitals": {
        "systolic": {
            "min": 60,
            "max": 260
        },
        "diastolic": {
            "min": 30,
            "max": 160
        },
        "heartRate": {
            "min": 25,
            "max": 220
        },
        "spo2": {
            "min": 50,
            "max": 100
        },
        "temperatureC": {
            "min": 30.0,
            "max": 44.0
        },
        "weightKg": {
            "min": 1.0,
            "max": 400.0
        }
    },
    "assertion": {
        "triggers": {
            "ABSENT": [
                "no evidence of",
                "no signs of",
                "no history of",
                "not been having",
                "absence of",
                "negative for",
                "free of",
                "without",
                "denies",
                "denied",
                "no",
                "not"
            ],
            "FAMILY": [
                "family history of",
                "family hx of",
                "fhx",
                "mother",
                "father",
                "brother",
                "sister",
                "sibling",
                "parents",
                "maternal",
                "paternal",
                "familial"
            ],
            "HYPOTHETICAL": [
                "rule out",
                "r/o",
                "return if",
                "call if",
                "come back if",
                "in case of",
                "possibility of",
                "possible",
                "concern for",
                "should there be",
                "if"
            ],
            "HISTORICAL": [
                "history of",
                "hx of",
                "status post",
                "s/p",
                "previous",
                "previously",
                "prior",
                "past medical history",
                "in the past"
            ]
        }
    }
}


def seeded_taxonomy() -> ClinicalTaxonomy:
    """The seeded platform baseline, parsed."""
    return ClinicalTaxonomy.model_validate(SEEDED_CLINICAL_TAXONOMY_JSON)
