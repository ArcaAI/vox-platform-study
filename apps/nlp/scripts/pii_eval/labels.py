"""The canonical label set, and which prediction labels may match which gold labels."""

from __future__ import annotations

PATIENT_NAME = "PATIENT_NAME"
RELATIVE_NAME = "RELATIVE_NAME"
CLINICIAN = "CLINICIAN"
DATE = "DATE"
AGE_OVER_89 = "AGE_OVER_89"
PHONE = "PHONE"
EMAIL = "EMAIL"
ADDRESS = "ADDRESS"
MRN = "MRN"
INSURANCE_ID = "INSURANCE_ID"
URL = "URL"
IP_ADDRESS = "IP_ADDRESS"
DEVICE_ID = "DEVICE_ID"
AADHAAR = "AADHAAR"
ABHA = "ABHA"
PAN = "PAN"
PIN_CODE = "PIN_CODE"

#: HIPAA direct identifiers plus the India-specific ones. CLINICIAN is NOT here: a
#: clinician's name is not the patient's PHI, so it is scored but never counted as residual.
PHI_LABELS: tuple[str, ...] = (
    PATIENT_NAME,
    RELATIVE_NAME,
    DATE,
    AGE_OVER_89,
    PHONE,
    EMAIL,
    ADDRESS,
    MRN,
    INSURANCE_ID,
    URL,
    IP_ADDRESS,
    DEVICE_ID,
    AADHAAR,
    ABHA,
    PAN,
    PIN_CODE,
)
GOLD_LABELS: tuple[str, ...] = (*PHI_LABELS, CLINICIAN)

#: Identifiers that name or reach a person directly (OD-30's "direct-identifier" bar).
DIRECT_IDENTIFIERS: frozenset[str] = frozenset(
    {
        PATIENT_NAME,
        RELATIVE_NAME,
        PHONE,
        EMAIL,
        ADDRESS,
        MRN,
        INSURANCE_ID,
        URL,
        IP_ADDRESS,
        DEVICE_ID,
        AADHAAR,
        ABHA,
        PAN,
    }
)
#: Quasi-identifiers: dates, ages over 89, postal codes.
QUASI_IDENTIFIERS: frozenset[str] = frozenset({DATE, AGE_OVER_89, PIN_CODE})

# Prediction-only labels. A detector that cannot tell a patient from a clinician, or a PAN
# from an MRN, emits the generic one; it may match any gold label of its family.
PERSON = "PERSON"
ID = "ID"
AGE = "AGE"
OTHER = "OTHER"  # a detection with no gold counterpart label (facility, ...): not scored

_GENERIC: dict[str, frozenset[str]] = {
    PERSON: frozenset({PATIENT_NAME, RELATIVE_NAME, CLINICIAN}),
    ID: frozenset({AADHAAR, ABHA, PAN, MRN, INSURANCE_ID, DEVICE_ID}),
    AGE: frozenset({AGE_OVER_89}),
}


def compatible(pred: str, gold: str) -> bool:
    """May a prediction labelled `pred` count as finding a gold span labelled `gold`?"""
    if pred == gold:
        return True
    return gold in _GENERIC.get(pred, frozenset())


#: GLiNER2 taxonomy label (the incumbents' `labelTaxonomy`) -> canonical prediction label.
GLINER_LABEL_MAP: dict[str, str] = {
    "person": PERSON,
    "full_name": PERSON,
    "first_name": PERSON,
    "middle_name": PERSON,
    "last_name": PERSON,
    "date_of_birth": DATE,
    "sensitive_date": DATE,
    "document_date": DATE,
    "expiration_date": DATE,
    "transaction_date": DATE,
    "date_of_service": DATE,
    "email": EMAIL,
    "phone_number": PHONE,
    "address": ADDRESS,
    "street_address": ADDRESS,
    "city": ADDRESS,
    "state_or_region": ADDRESS,
    "country": ADDRESS,
    "postal_code": PIN_CODE,
    "government_id": ID,
    "national_id_number": ID,
    "passport_number": ID,
    "drivers_license_number": ID,
    "license_number": ID,
    "tax_id": ID,
    "tax_number": ID,
    "bank_account": ID,
    "account_number": ID,
    "account_id": ID,
    "sensitive_account_id": ID,
    "medical_record_number": MRN,
    "patient_id": MRN,
    "encounter_id": ID,
    "staff_id": ID,
    "ip_address": IP_ADDRESS,
    "username": ID,
}


def canonical(raw_label: str, mapping: dict[str, str]) -> str:
    return mapping.get(raw_label.strip().lower().replace(" ", "_"), OTHER)
