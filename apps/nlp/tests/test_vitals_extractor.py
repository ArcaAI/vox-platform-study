"""Deterministic vitals extraction.

The parser is cue-gated and range-guarded: a mis-parse must fail SAFE to
``None`` rather than emit a wrong number, and nothing is ever fabricated.
"""

from nlp.services import vitals_extractor as _vitals_extractor
from tests.clinical_taxonomy_fixture import seeded_taxonomy

_BANDS = seeded_taxonomy().vitals


def extract_vitals(text):
    """`extract_vitals` with the seeded plausibility bands supplied.

    TASK-799 lane G: the bands are configuration and arrive per request on
    `clinicalTaxonomy.vitals`, so every case here passes the seeded platform
    baseline. `test_task799_lane_g_taxonomy.py` pins the other half — a narrowed
    stored band discards a reading the wider one accepted, and no bands at all
    means no vital is emitted.
    """
    return _vitals_extractor.extract_vitals(text, _BANDS)


def test_returns_none_for_empty_or_vital_less_text():
    assert extract_vitals("") is None
    assert extract_vitals("   ") is None
    assert extract_vitals("Patient reports feeling much better today.") is None


def test_blood_pressure_slash_and_over_forms():
    v = extract_vitals("BP 138/88 today.")
    assert v is not None and v.systolic == 138 and v.diastolic == 88

    v2 = extract_vitals("Blood pressure was 120 over 80.")
    assert v2 is not None and v2.systolic == 120 and v2.diastolic == 80


def test_blood_pressure_rejects_implausible_or_inverted():
    # diastolic > systolic → not a valid BP → no BP fields
    v = extract_vitals("readings 80 over 138")
    assert v is None or (v.systolic is None and v.diastolic is None)
    # out of physiologic range
    v2 = extract_vitals("300/200")
    assert v2 is None or (v2.systolic is None and v2.diastolic is None)


def test_heart_rate_requires_cue():
    v = extract_vitals("Heart rate 78 and regular.")
    assert v is not None and v.heart_rate == 78
    # a bare number with no cue must not be read as HR
    v2 = extract_vitals("She has 78 things to do.")
    assert v2 is None or v2.heart_rate is None


def test_spo2_variants():
    for text in ("SpO2 98%", "oxygen saturation 96", "O2 sat 94%"):
        v = extract_vitals(text)
        assert v is not None and v.spo2 is not None and 90 <= v.spo2 <= 100


def test_temperature_celsius_and_fahrenheit_conversion():
    v = extract_vitals("Temp 36.8 C")
    assert v is not None and v.temperature_c == 36.8
    vf = extract_vitals("temperature 98.6 F")
    assert vf is not None and vf.temperature_c == 37.0
    # Unlabeled Fahrenheit-range value converts to a plausible Celsius.
    vf2 = extract_vitals("temperature 99.5")
    assert vf2 is not None and 37.0 <= (vf2.temperature_c or 0) <= 38.0


def test_weight_kg_and_pound_conversion():
    v = extract_vitals("Weight 71 kg")
    assert v is not None and v.weight_kg == 71.0
    vlb = extract_vitals("weight 154 lbs")
    assert vlb is not None and vlb.weight_kg is not None and 69 <= vlb.weight_kg <= 71


def test_combined_narration():
    v = extract_vitals("Vitals: BP 138/88, HR 78, SpO2 98%, temp 36.8 C, weight 71 kg.")
    assert v is not None
    assert (v.systolic, v.diastolic) == (138, 88)
    assert v.heart_rate == 78
    assert v.spo2 == 98
    assert v.temperature_c == 36.8
    assert v.weight_kg == 71.0
    assert v.has_any() is True


def test_out_of_range_fields_fail_safe_to_none():
    # HR 400 is implausible → None (not clamped, not shown)
    v = extract_vitals("heart rate 400")
    assert v is None or v.heart_rate is None
    # SpO2 40 is below the sane floor → None
    v2 = extract_vitals("SpO2 40%")
    assert v2 is None or v2.spo2 is None
