"""TASK-330 Phase 3 — live StrictCitations + citation_verify proof (harness layer).

Exercises the cite->verify half of the loop with the REAL Phase-3 code paths and
REAL models, against the LIVE seeded tenant-A hypertension chunk:

  retrieve (live hybrid: bge-m3 + Qdrant + TEI reranker)
    -> build_strict_citations_block   (REAL prompt block)
    -> generate SOAP note              (Ollama gemma3:latest == HARNESS_SMR_MODEL)
    -> NER over note + transcript      (REAL NlpClient, :8864)
    -> build_citations_map             (REAL strict [[kb:]] parser, hallucinated ids dropped)
    -> CitationVerifySensor.arun       (REAL sensor + REAL LM Studio judge, threshold 0.8)

The generation model is invoked directly over Ollama's chat API — it is the SAME
model id the harness SMR activity calls (apps/harness/.env HARNESS_SMR_PROVIDER=ollama,
HARNESS_SMR_MODEL=gemma3:latest); only the SMR HTTP wrapper is bypassed so we don't
need the separate :8872 live-verification SMR instance for this proof.

Run:
  PYTHONPATH=apps/harness/src conda run -n arcaenv \
    python apps/harness/scripts/task_330_phase3_cite_verify_check.py
"""

from __future__ import annotations

import asyncio
import json

import httpx

from harness.core.config import get_settings
from harness.guides.retrieval.prompt import build_strict_citations_block
from harness.sensors.base import NEREntity, SensorContext
from harness.sensors.config import SensorThresholds
from harness.sensors.inferential import CitationVerifySensor
from harness.services.nlp_client import NlpClient
from harness.services.provenance import build_citations_map
from harness.temporal.activities import _build_runtime_judge, _hybrid_retriever

TENANT_A = "50000000-0000-0000-0000-000000000000"
OLLAMA_CHAT = "http://localhost:11434/api/chat"
SMR_MODEL = "gemma3:latest"  # == HARNESS_SMR_MODEL

# A hypertension follow-up consultation that topically overlaps the seeded
# institutional protocol, so the retriever has something meaningful to cite.
TRANSCRIPT = (
    "Doctor: Good morning. Your home blood pressure readings have averaged about "
    "148 over 92 over the last two weeks. Patient: Yes, I have been taking the "
    "amlodipine every day but the numbers are still high. Doctor: Your office "
    "reading today is 150 over 94, which is stage 2 hypertension. You are already "
    "on a calcium channel blocker and still above goal, so I want to add a second "
    "medicine. We will start lisinopril, an ACE inhibitor, and aim for a blood "
    "pressure below 130 over 80. We will check your kidney function and "
    "electrolytes in two to four weeks and review your home readings then. Please "
    "keep up the low-salt DASH diet and your regular walking."
)

RETRIEVAL_QUERY = (
    "stage 2 hypertension management: first-line agents, add-on therapy, blood "
    "pressure target, electrolyte and kidney follow-up cadence"
)

_GEN_SYSTEM = (
    "You are a clinical scribe. Write a concise SOAP note for the consultation "
    "below, grounded ONLY in the transcript. Return STRICT JSON with exactly the "
    "keys subjective, objective, assessment, plan (string values). Follow the "
    "KNOWLEDGE CONTEXT citation instruction precisely: when a statement is "
    "supported by a knowledge item, append its [[kb:<id>]] marker inline right "
    "after that statement, copying the id exactly. Cite the institutional "
    "reference ONLY after general hypertension-management statements it actually "
    "supports — the target blood pressure, the choice of a first-line or add-on "
    "antihypertensive drug class, the monitoring/follow-up cadence, and lifestyle "
    "advice (these belong in Assessment/Plan). NEVER cite a patient-specific "
    "measurement, symptom, or history (e.g. today's readings) — the reference "
    "does not support those."
)


def _clean_entities(ents: list[NEREntity]) -> list[NEREntity]:
    """Strip the SentencePiece word-boundary marker (U+2581) the live NLP service
    prepends to tokens. The provenance builder cleans it from claim *text* but the
    section-matching path (``normalized``/``_derive_section``) compares against
    section text that never contains it; stripping here makes section attribution
    correct (otherwise every entity falls through to the default section)."""
    out: list[NEREntity] = []
    for e in ents:
        text = " ".join(e.text.replace("\u2581", " ").split())
        if text:
            out.append(NEREntity(text=text, type=e.type, start=e.start, end=e.end))
    return out


async def _generate_soap(block: str) -> dict:
    """Generate a SOAP note (JSON) via Ollama gemma3 — the harness SMR model."""
    user = f"KNOWLEDGE CONTEXT:\n{block}\n\nCONSULTATION TRANSCRIPT:\n{TRANSCRIPT}"
    payload = {
        "model": SMR_MODEL,
        "messages": [
            {"role": "system", "content": _GEN_SYSTEM},
            {"role": "user", "content": user},
        ],
        "format": "json",
        "stream": False,
        "options": {"temperature": 0.2},
    }
    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(OLLAMA_CHAT, json=payload)
        resp.raise_for_status()
        content = resp.json()["message"]["content"]
    data = json.loads(content)
    return {k: str(data.get(k, "")) for k in ("subjective", "objective", "assessment", "plan")}


async def main() -> None:
    settings = get_settings()

    # 1) Live retrieval (proven separately) -> chunks + knowledge_chunks map.
    retriever = _hybrid_retriever(settings)
    result = await retriever.retrieve(query=RETRIEVAL_QUERY, tenant_id=TENANT_A)
    chunks = result.chunks
    chunk_ids = [c.chunk_id for c in chunks]
    knowledge_chunks = {c.chunk_id: c.text for c in chunks}
    print("=== 1. RETRIEVE (live) ===")
    print(f"  degraded={result.degraded} n_chunks={len(chunks)} ids={chunk_ids}")
    if not chunks:
        print("  no chunks retrieved — cannot demonstrate citation; aborting.")
        return

    # 2) StrictCitations prompt block (REAL).
    block = build_strict_citations_block(chunks)
    print("\n=== 2. STRICT-CITATIONS BLOCK (real) ===")
    print("  " + block.splitlines()[0][:120] + " ...")

    # 3) Generate the SOAP note (Ollama gemma3 == HARNESS_SMR_MODEL).
    soap = await _generate_soap(block)
    note_text = "\n".join(f"{k.upper()}: {v}" for k, v in soap.items())
    print("\n=== 3. GENERATED SOAP NOTE (gemma3:latest) ===")
    for k, v in soap.items():
        print(f"  [{k}] {v[:240]}")
    cited_inline = any(f"[[kb:{cid}]]" in note_text for cid in chunk_ids)
    print(f"  -> note contains a valid [[kb:<retrieved id>]] marker: {cited_inline}")

    # 4) NER over note + transcript (REAL NlpClient, :8864).
    nlp = NlpClient(settings.nlp_base_url, timeout=settings.nlp_timeout_s)
    note_entities = _clean_entities(await nlp.classify_tokens(note_text, language="en"))
    transcript_entities = _clean_entities(await nlp.classify_tokens(TRANSCRIPT, language="en"))
    print("\n=== 4. NER (real NLP, SentencePiece marker stripped) ===")
    print(f"  note_entities={len(note_entities)} transcript_entities={len(transcript_entities)}")

    # 5) Strict citation parse -> citations_map (REAL).
    citations_map = build_citations_map(
        soap_sections=soap,
        note_entities=note_entities,
        transcript_entities=transcript_entities,
        transcript_text=TRANSCRIPT,
        transcript_context_item_id="e2e-transcript-1",
        retrieved_chunk_ids=chunk_ids,
    )
    cited_claims = [c for c in citations_map["claims"] if c.get("knowledgeChunkIds")]
    print("\n=== 5. CITATIONS MAP (real strict [[kb:]] parser) ===")
    print(f"  total_claims={len(citations_map['claims'])} cited_claims={len(cited_claims)}")
    for c in cited_claims[:8]:
        print(f"    claim {c['id']} sec={c['section']} kb={c['knowledgeChunkIds']} text={c['text'][:70]!r}")

    # 6) citation_verify (REAL sensor + REAL LM Studio judge, threshold 0.8).
    print("\n=== 6. CITATION_VERIFY (real sensor + real judge) ===")
    try:
        judge = _build_runtime_judge()
    except Exception as exc:  # noqa: BLE001
        print(f"  judge unavailable: {exc} -> would DEGRADE to 'unverified' badge")
        return
    ctx = SensorContext(
        note_text=note_text,
        transcript_text=TRANSCRIPT,
        citations_map=citations_map,
        knowledge_chunks=knowledge_chunks,
    )
    sensor = CitationVerifySensor(threshold=SensorThresholds().citation_verify_threshold)
    sresult = await sensor.arun(ctx, judge=judge)
    print(f"  score={round(sresult.score, 4)} passed={sresult.passed} degraded={sresult.degraded}")
    print(f"  details={json.dumps(sresult.details, ensure_ascii=False)}")

    print("\n===== SUMMARY =====")
    print(f"  retrieved cited chunk         : {'PASS' if chunk_ids else 'FAIL'} ({chunk_ids})")
    print(f"  model emitted [[kb:]] marker  : {'PASS' if cited_inline else 'FAIL'}")
    print(f"  citationsMap knowledgeChunkIds: {'PASS' if cited_claims else 'FAIL'} ({len(cited_claims)} cited claims)")
    verdict = sresult.passed and not sresult.degraded
    print(f"  citation_verify PASS          : {'PASS' if verdict else ('DEGRADED' if sresult.degraded else 'FAIL')}")


if __name__ == "__main__":
    asyncio.run(main())
