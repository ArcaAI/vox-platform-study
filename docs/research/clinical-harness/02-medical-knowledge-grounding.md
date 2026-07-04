# 02 · Medical Knowledge Grounding

> Corpora (+ licensing), embedding models, hybrid retrieval, ontology/terminology linking, faithfulness/citation,
> and benchmarks. **Headline for HOPE:** the *internal + institutional* grounding choice (TASK-330 D5) sidesteps the
> licensing minefield; the provisioned Qdrant `context_items` collection is **1536-dim** → use OpenAI
> `text-embedding-3-small` as the baseline (MedCPT/BioLORD are 768-dim → would need a new collection).

---

## Key findings
- **RAG materially helps medical LLMs; the *combination* of corpora + retrievers matters most.** MIRAGE (7,663 Qs,
  5 datasets): MedRAG lifts accuracy up to **+18% over chain-of-thought**, pushing GPT-3.5/Mixtral to GPT-4 level;
  documents a **"lost-in-the-middle"** effect and log-linear scaling with retrieved snippets. [1][2]
- **PubMed is the single most reliable corpus; "MedCorp" (PubMed+StatPearls+textbooks+Wikipedia) is best overall.**
  In MIRAGE, **only PubMed and MedCorp beat CoT on all tasks**; single non-PubMed corpora are not recommended alone. [2][3]
- **MedCPT is the best-evidenced biomedical retriever** — bi-encoder + cross-encoder, init from PubMedBERT, trained
  on **255M PubMed query–article pairs**; SOTA on BEIR biomedical IR; **RRF-2 (BM25 + MedCPT)** is a strong default.
  Output dim **768**. [1][4][5][6]
- **BioLORD-2023 is the best concept/sentence-similarity model** (great for NER normalisation, not document
  retrieval); UMLS-KG + LLM training; multilingual variant covers 50+ languages. [7]
- **General baselines are competitive and cheaper:** BGE-base/GTE-base/Nomic-v1.5 = **768**; OpenAI
  `text-embedding-3-small` = **1536**; E5-Mistral-7B = **4096**. A 2026 clinical study found *context variables
  rival model choice* — good chunking/metadata can matter as much as the embedder. [8][9]
- **Hybrid + rerank is the production gold standard:** BM25 + dense → **RRF (k≈60; k≈10–20 small corpora)** →
  cross-encoder rerank top 50–100 → top ~10; truncate rerank inputs ≤512 tokens; keep a fallback to raw hybrid. [29]
- **Chunking:** recursive **400–512 tokens, 10–20% overlap** is the right default; semantic chunking often
  over-fragments; for clinical content, *adaptive/topic-aligned* chunking measurably outperforms fixed-size
  (one CDS study: **87% vs ~13%**, p=0.001). [27][28]
- **Faithfulness is the core safety lever:** the **RAG triad** (context relevance, groundedness/faithfulness, answer
  relevance) + citation enforcement + a *refusal* path; clinical variant **ASTRID** adds Refusal Accuracy +
  Conversational Faithfulness. [20][21][23]
- **Citation-backed generation needs verification, not just "show sources":** models hallucinate citations;
  **MedCite** (multi-pass retrieve→cite→refine) and Generate-then-Refine improve attribution; **MEGA-RAG**
  (dense+BM25+KG+cross-encoder+discrepancy refinement) cut hallucinations **>40%**. [22][30][2]
- **Licensing is the gating constraint:** PubMed/MEDLINE, RxNorm, CDC, and federal-authored MedlinePlus are usable;
  **StatPearls is CC BY-NC-ND (no commercial use, no derivatives)**; UpToDate/DynaMed are proprietary; SNOMED CT
  needs an Affiliate/UMLS licence; UMLS source vocabularies carry per-source restriction levels. [10][11][12][13][14][15]

## Recommended corpora (with licensing notes)
| Corpus | Content | Commercial use? | Notes | Src |
|---|---|---|---|---|
| **PubMed/MEDLINE** (abstracts) | 30M+ abstracts | ✅ primary choice | public, bulk-downloadable; respect E-utilities/FTP terms | [2][3] |
| **PubMed Central OA subset** | full-text OA | ⚠️ per-article | mixed CC; filter to CC-BY/CC0 | [30] |
| **MedlinePlus** | consumer health | ⚠️ partial | federal-authored = public domain; cannot ingest licensed portions | [15] |
| **CDC guidance** | public-health/clinical | ✅ mostly | largely public domain; attribute | [14] |
| **WHO guidelines** | global clinical | ⚠️ non-commercial default | most CC BY-NC-SA 3.0 IGO | [14] |
| **ICD-11** (codes) | classification | ✅ | CC BY-ND 3.0 IGO — no adaptation of codes; cite | [14] |
| **NICE guidelines** | UK clinical | ⚠️ UK-only free | UK Open Content Licence; excludes BNF/CKS; outside-UK via paid API | [16] |
| **StatPearls** | clinical reviews | ❌ **no** | **CC BY-NC-ND 4.0**; ToS forbids scraping/commercial reuse | [10] |
| **UpToDate / DynaMed** | point-of-care | ❌ not without licence | proprietary; no redistribution/ingestion | — |
| **Medical textbooks** (MedQA set) | domain knowledge | ⚠️ check | copyright varies; MedRAG set is research-licensed | [3] |

**Net for a commercial product:** build a groundable corpus on **PubMed/MEDLINE + filtered PMC-OA (CC-BY) + CDC +
ICD-11 codes**; treat StatPearls/UpToDate/DynaMed/WHO as licence-gated. **HOPE's D5 choice (tenant-owned
institutional docs) avoids all of this.**

## Recommended embedding + retrieval + linking stack
- **Dense:** **MedCPT** Query/Article encoders (768-dim) for biomedical literature. [4][5][6]
- **Sparse:** **BM25** (exact terms, drug/code/abbreviation matches). [1][29]
- **Fusion:** **RRF (k≈60)** combining BM25 + MedCPT ("RRF-2"). [1][2]
- **Rerank:** cross-encoder — **MedCPT Cross-Encoder** (in-domain) or **BGE-reranker-v2-m3 / Cohere Rerank 3.5**;
  top 50–100 → ~8–10; inputs ≤512 tokens; fallback to hybrid on timeout. [4][29]
- **General-baseline option (fits existing 1536 infra):** **OpenAI `text-embedding-3-small`** or BGE/GTE-base (768). [8][9]
- **Chunking:** recursive 400–512 tokens, 10–20% overlap; section/topic-aligned for structured docs; rich metadata
  (source, section, pub date, PMID/URL, code tags). [27][28]

**Ontology / terminology linking (entity normalisation)**
| Tool | Targets | Strengths | Notes | Src |
|---|---|---|---|---|
| **scispaCy + UMLS linker** | UMLS, MeSH, RxNorm, GO, HPO | fast, easy Python | good starting point | [19] |
| **MedCAT v2** | SNOMED-CT, UMLS, HPO | strong production NER+L; trainable; pre-trained MIMIC-IV + UMLS 2024AA | best accuracy at scale; needs UMLS/SNOMED licence | [17][18] |
| **QuickUMLS** | UMLS | fast dictionary matcher | lightweight, lower precision | [17] |
| **MetaMap / MetaMapLite** | UMLS | NLM-standard | slower; integrated mention+link | [17] |
| **BioLORD-2023** | concept embeddings | SOTA concept/STS for disambiguation/NEL | embedding backbone for linking, not doc retrieval | [7] |

Map NER spans → **UMLS CUI**, then crosswalk to **SNOMED CT** (problems), **RxNorm** (meds), **LOINC** (labs),
**ICD-10/11** (billing). All require a (free) **UMLS Metathesaurus licence**; check per-source restriction levels
before storing codes in operational records. [11][12][13]

## Faithfulness / eval techniques
- **RAG triad** — context relevance, groundedness/faithfulness (claim-level attribution), answer relevance. [20]
- **ASTRID** (clinical) — add **Refusal Accuracy** + **Conversational Faithfulness**; validated on real patient Qs. [21]
- **StrictCitations prompting** — require a source ID per claim; turns the LLM into a "verifiable extractor"; strongly
  correlates with correctness (MDPI, N=500). [23]
- **Verify citations, don't trust them** — **MedCite** / Generate-then-Refine add/remove citations to fix hallucinated
  attributions. [22]
- **NLI/entailment grounding checks** — split answer into claims; check entailment vs retrieved context. [20]
- **MEGA-RAG** — multi-evidence + discrepancy refinement → **>40% hallucination reduction**, F1 ≈0.79. [30]
- **Watch numeric claims** — doses, percentages, dates, names hallucinate most; add a completeness/context-recall check. [—]

## Benchmarks
| Benchmark | Measures | Headline | Src |
|---|---|---|---|
| **MIRAGE / MedRAG** | end-to-end medical RAG (5 datasets, 7,663 MCQs) | GPT-4 CoT ~73.4 → MedRAG ~80.0; MedCPT best retriever | [1][2] |
| **MedQA (USMLE)** | clinical reasoning (4-opt MCQ) | top LLMs ~84% (GPT-4 CoT) | [2] |
| **MedMCQA** | broad knowledge (194k MCQ) | GPT-4 CoT ~70% (MIRAGE subset) | [2][25] |
| **PubMedQA** | reasoning over an abstract (yes/no/maybe) | GPT-4 (Medprompt) 82.0%; Med-PaLM 2 81.8% | [24] |
| **BioASQ** | realistic biomedical QA + retrieval + "ideal answers" | closest analog to clinical-summary generation | [26] |

## Recommendations for HOPE
1. **For institutional grounding (D5)**, ingest tenant-owned approved docs into the existing **1536-dim**
   `context_items` collection with **`text-embedding-3-small`** — no dimension migration. Chunk ~400–512 tokens,
   10–20% overlap, metadata (source, section, version/date, code tags). [8][9][27][28]
2. **If/when biomedical-literature grounding is added later**, provision a **new 768-dim** collection
   (`context_items_medcpt`) for MedCPT — don't force MedCPT into the 1536 collection. [4][8]
3. **Hybrid + rerank:** BM25 + dense fused via **RRF (k≈60)**, then cross-encoder rerank → top ~8. [1][4][29]
4. **Just-in-time retrieval at summarisation** (query = SOAP draft / NER concepts); keep top-k modest (~8–16) to avoid
   lost-in-the-middle. [1][2]
5. **Add ontology linking at the NER stage:** start with **scispaCy + UMLS**, plan migration to **MedCAT v2**; store
   CUI + SNOMED/RxNorm/LOINC/ICD crosswalks per entity. [17][18][19]
6. **Obtain a (free) UMLS licence + SNOMED CT Affiliate coverage** before shipping coded output; honour per-source
   restriction levels. [11][12][13]
7. **Wire faithfulness gates into the review step:** RAG triad per SOAP section + **StrictCitations** + a **refusal /
   "insufficient evidence"** path (ASTRID). [20][21][23]
8. **Verify citations post-hoc** (MedCite-style / NLI) before surfacing; flag any claim whose cited chunk doesn't
   entail it (esp. doses/numbers/drug names). [22][30]
9. **Light up Langfuse for grounding telemetry:** retrieved chunk IDs, RRF/rerank scores, faithfulness/context-
   relevance scores, refusal + citation-verification pass rates per note. [1][20]
10. **Stand up a small internal eval set** mirroring PubMedQA/BioASQ + your own SOAP samples (golden chunks +
    faithfulness labels) so chunking/embedder/reranker choices are decided by measurement. [2][24][26][9]

## Sources
1. MIRAGE/MedRAG — Benchmarking RAG for Medicine (ACL Findings 2024): https://aclanthology.org/2024.findings-acl.372/
2. MIRAGE paper (full HTML): https://arxiv.org/html/2402.13178v1
3. MedRAG toolkit & corpora: https://github.com/Teddy-XiongGZ/MedRAG
4. MedCPT paper (Bioinformatics 2023, PMC): https://pmc.ncbi.nlm.nih.gov/articles/PMC10627406/
5. MedCPT preprint (arXiv 2307.00589): https://arxiv.org/pdf/2307.00589
6. MedCPT Query Encoder (HF): https://huggingface.co/ncbi/MedCPT-Query-Encoder
7. BioLORD-2023 (JAMIA / PubMed 38412333): https://pubmed.ncbi.nlm.nih.gov/38412333/
8. Towards Domain Specification of Embedding Models in Medicine (arXiv 2507.19407): https://arxiv.org/html/2507.19407v1
9. Clinical context vs model choice in embedding retrieval (JMIR Med Inform 2026): https://medinform.jmir.org/2026/1/e94241
10. StatPearls license (CC BY-NC-ND 4.0): https://www.ncbi.nlm.nih.gov/books/NBK430685/
11. UMLS Metathesaurus License Agreement: https://uts.nlm.nih.gov/uts/assets/LicenseAgreement.pdf
12. SNOMED CT licensing (NLM): https://www.nlm.nih.gov/healthit/snomedct/snomed_licensing.html
13. RxNorm FAQ / licensing (NLM): https://www.nlm.nih.gov/research/umls/rxnorm/faq.html
14. WHO copyright + ICD-11 license: https://www.who.int/copyright
15. MedlinePlus — using content: https://medlineplus.gov/about/using/usingcontent/
16. NICE UK Open Content Licence (+ Syndication API): https://www.nice.org.uk/reusing-our-content/nice-uk-open-content-licence
17. MedCAT v2 (CogStack): https://github.com/CogStack/cogstack-nlp/tree/main/medcat-v2
18. MedCAT v2 docs: https://medcat2.readthedocs.io/en/stable/main.html
19. scispaCy entity linkers: https://oyewusiwuraola.medium.com/how-to-use-scispacy-entity-linkers-for-biomedical-named-entities-7cf13b29ef67
20. RAG triad (TruLens): https://www.trulens.org/getting_started/core_concepts/rag_triad/
21. ASTRID — clinical RAG eval triad (ACL Findings 2025): https://aclanthology.org/2025.findings-acl.857/
22. MedCite — verifiable text for medicine (arXiv 2506.06605): https://arxiv.org/html/2506.06605v1
23. Citation-enforced prompting in medical RAG (MDPI Applied Sciences): https://www.mdpi.com/2076-3417/16/6/3013
24. PubMedQA homepage + leaderboard: https://pubmedqa.github.io/index.html
25. MedMCQA homepage: https://medmcqa.github.io/
26. BioASQ-QA corpus (bioRxiv): https://www.biorxiv.org/content/10.1101/2022.12.14.520213v1
27. Advanced chunking for clinical decision-support RAG (PMC): https://pmc.ncbi.nlm.nih.gov/articles/PMC12649634/
28. Best chunking strategies for RAG 2026 (Firecrawl): https://www.firecrawl.dev/blog/best-chunking-strategies-rag
29. Hybrid search BM25 + vector + reranking (2026): https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026
30. MEGA-RAG — multi-evidence hallucination mitigation (Frontiers Public Health 2025): https://www.frontiersin.org/journals/public-health/articles/10.3389/fpubh.2025.1635381/full
