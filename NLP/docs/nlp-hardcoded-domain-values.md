# NLP Hardcoded Domain Values — Diagnosis and Spelling

Oct 14, 2026 · @josekutty

## Summary

Both features carry hardcoded medical data in code or repo files, unlike NER, whose rules come from the database. Both hurt result quality today, and diagnosis does not work at all.

- **Diagnosis:** the 41 disease names, the entity types used as symptoms, and the thresholds are hardcoded in `services/medical_suggester.py`. The entity types use `B-`/`I-` tags that the NER output never has, so every request returns an empty list. Even when fixed, results depend on word order and only the top disease is returned.
- **Spelling:** the languages (en, ml), the Wikipedia word lists and the SymSpell settings are fixed. Common words beat medical ones: `amoxcillin` becomes **ampicillin**, `no fever` becomes **to fever**, and the Malayalam typo for "fever" becomes "you". Bigrams never load.
- **Fix first:** the diagnosis filter, then protect negations and drug names in spelling. Then move the label map and medical word lists into model metadata, as the NER taxonomy already is.

## Diagnosis suggestions

All hardcoded values sit in `apps/nlp/src/nlp/services/medical_suggester.py` (branch `dev-2.2`, re-checked at commit `8cb2e5e8` on 2026-10-22; none of these values changed). Unlike the NER taxonomy, none of them come from the database, so changing any of them needs a code change and redeploy.

The flow: the request's text goes to Medical-NER, entities are filtered, joined into a symptom string, and passed to `shanover/symps_disease_bert_v3_c41`, whose output label is translated to a disease name.

| Hardcoded value | Lines | How it is used | Effect on quality |
| --- | --- | --- | --- |
| 41-entry map `LABEL_0` → "Vertigo (Paroxysmal Positional Vertigo)" … `LABEL_40` → "Hepatitis A" | 75–116 | Turns the model's output label into a disease name (`_to_readable_label`, 273–287) | The model's own config only has `LABEL_0..40`, so this list is the only source of names; its order cannot be verified from the model. A shift by one would mislabel every prediction. Spot checks look consistent (chest pain → Heart attack). Coverage is fixed at 41 diseases: no stroke, COVID, anaemia, etc. |
| Entity types kept: `B-SIGN_SYMPTOM`, `I-SIGN_SYMPTOM`, … (16 BIO tags) | 178–195 | Only entities with these types feed the disease model | **Breaks the feature.** NER runs with aggregation "simple" (`token_classifier.py:227–229`), which returns plain types like `SIGN_SYMPTOM`, never `B-`/`I-`. Every entity is dropped, so the response is always empty |
| Default `min_confidence = 0.1` | 135 | Used for both the entity filter and the disease filter | Low bar: weak NER guesses (e.g. "chest" at 0.12) count as symptoms |
| Entity text must be longer than 2 characters | 202 | Drops short tokens | Drops real terms like "BP", "HR", "Rx" |
| Symptom string built with `", ".join(set(...))` | 241 | Input text for the disease model | `set()` order changes per process, and the model is sensitive to order: the same 4 symptoms gave Chicken pox 0.56 vs 0.51 and a different runner-up |
| Priority: `SIGN_SYMPTOM`, then `SEVERITY`, then `DURATION` | 225–238 | Intended ordering | Undone by the `set()` on line 241 |
| Disease pipeline called without `top_k` | 258 | One prediction per request | Only the top disease is ever returned, though the response is a list |
| NER called with only `text` and `language` | 138–140 | No `clinical_taxonomy`, so no negation | "denies fever" would still count as fever |
| Errors return `{}` | 269–271 | Fail-soft | A broken model looks the same as "no diagnosis" |

The diagnosis route itself (`api/v1/rest/diagnosis.py`) requires `model_name` and `ner_model_name` from the caller, so the models are not hardcoded; only the label names and rules around them are.

## Spelling correction

Spelling uses SymSpell, not a model: it picks the most frequent dictionary word within 2 edits. So the word lists decide the answer, and they are general-purpose Wikipedia counts shipped inside the repo.

| Hardcoded value | Where | How it is used | Effect on quality |
| --- | --- | --- | --- |
| Languages `en` and `ml` only | `schemas/common.py:80–82` (`SupportedLanguage`), `services/text_corrector.py:49–71` | Each language gets one SymSpell instance; anything else is a 422 | Adding a language needs code changes in two places |
| Word lists `data/dictionaries/{en,ml}/{unigram,bigram}.txt` | `apps/nlp/data/dictionaries/` | Source of every correction | English: 113,361 words from Wikipedia. 10 of 43 common clinical terms are missing (amoxicillin, metformin, amlodipine, atorvastatin, omeprazole, azithromycin, ceftriaxone, salbutamol, haemoglobin, dyspnoea). Others are present but rare (paracetamol 172 vs "over" 490,761), so common words win |
| File names and paths `/en/bigram.txt` etc. | `text_corrector.py:55, 58, 67, 70` | Path is `dictionary_path` + a fixed suffix | Only the folder is configurable (`SPELLING_CORRECTOR_DICTIONARY_PATH`); file layout is fixed |
| Bigram column `count_index=1` | `text_corrector.py:55, 67` | Bigram lines are `word1 word2 count`, so column 1 is a word | 0 of 695,116 English bigrams load; Malayalam likewise. Context never helps |
| `max_edit_distance=2`, `prefix_length=7` | `core/config.py:626–627` | How far a correction may reach | 2 edits is wide for short words: `no` → `to`, `fver` → `over`. Malayalam ignores `prefix_length` (`text_corrector.py:63–65`) |
| `preserve_case`, `ignore_non_words`, `ignore_term_with_digits` = true | `core/config.py:628–630` | Compound lookup options | Reasonable; numbers like "75mg" are left alone |
| Default `dictionary_path` = repo `data/dictionaries` | `core/config.py:624` | Where files load from | The Docker image does not copy `data/`, so production has no dictionaries |
| Request fields `type`, `min_confidence`, `include_alternatives` | `schemas/correction.py` | Accepted, never read by `correct()` | Callers cannot limit risky corrections |

The English and Malayalam medical words that are present have low counts (പനി "fever" 608, ശ്വാസംമുട്ടൽ "breathlessness" 15), so a typo near any common word goes to the common word.

## Measured evidence

All results below were run on 2026-10-14 against the real code, data and models on `dev-2.2`, locally on CPU. Re-checked on 2026-10-22 at `8cb2e5e8`: diagnosis still returns an empty list, and the dictionaries and spelling code are unchanged, so the spelling results still hold; spelling itself still returns 503 on that commit.

### Diagnosis

`POST /api/v1/diagnosis/suggestions` with "Patient has high fever, severe headache, joint pain and skin rash for 3 days", `min_confidence: 0` and the seeded models returned `{"suggestions":[],"symptoms_analyzed":[]}`. The entity filter removed every entity, so the disease model never ran.

Calling the disease model directly with the symptom strings it should have received:

| Symptom string | Default call returns | Top 3 with `top_k=3` |
| --- | --- | --- |
| fever, headache, joint pain, skin rash | 1 result | Chicken pox 0.56, Impetigo 0.06, Malaria 0.06 |
| skin rash, joint pain, headache, fever (same words, new order) | 1 result | Chicken pox 0.51, Malaria 0.09, Jaundice 0.06 |
| chest pain, shortness of breath, sweating | 1 result | Heart attack 0.50, Hypertension 0.33, Pneumonia 0.01 |
| itching, skin rash | 1 result | Fungal infection 0.34, Impetigo 0.15, Chicken pox 0.11 |
| denies fever, cough | 1 result | GERD 0.27, Pneumonia 0.19, Malaria 0.12 |

Word order alone changed the score and the runner-up, and negated symptoms are treated as present.

### Spelling

Corrections exactly as the code runs today, and with the bigram load fixed:

| Input | Today | Bigrams fixed | Correct? |
| --- | --- | --- | --- |
| hedache, nausia, diabetis, pnemonia, paracetmol, hypertenson | headache, nausea, diabetes, pneumonia, paracetamol, hypertension | same | Yes |
| blood presure is high | blood pressure is high | same | Yes |
| fver | over | over | No |
| cogh | gogh | gogh | No |
| amoxcillin | **ampicillin** | ampicillin | No — a different drug |
| metfromin, amlodipne | unchanged | unchanged | No — not in dictionary |
| shortnes of breth | shortness of brett | same | No |
| no fever | **to fever** | to fever | No — negation lost |
| പനീ (fever typo) | നീ ("you") | — | No |
| തലവേതന (headache typo) | തലവേദന | — | Yes |
| ചുമാ (cough typo) | ജുമാ | — | No |

Fixing the bigram load changed none of these results; the dictionary contents are the limiting factor.

## Recommendations

In priority order; the first three are small code fixes, the rest move values out of code the way the NER taxonomy already works.

1. **Fix the diagnosis entity filter.** Compare on the type with any `B-`/`I-` prefix stripped (`medical_suggester.py:178–200`). Without this the endpoint returns nothing. Add a test that runs a real aggregated NER result through `suggest()`.
2. **Make diagnosis output deterministic and complete.** Replace `set()` with order-preserving de-duplication (line 241) and pass `top_k` to the disease pipeline (line 258).
3. **Pass the clinical taxonomy into the diagnosis NER call** (lines 138–140) and drop entities marked ABSENT, so "denies fever" is not a symptom.
4. **Move the 41-name label map to the database.** Store it in the model's `AiModel.metaData` (like `clinicalTaxonomy`) and send it with the request, or read `id2label` from a model that carries names. Then a new disease model needs no code change.
5. **Move the entity types, minimum length and default confidence to the same metadata**, so they match whichever NER model is selected.
6. **Stop risky spelling corrections.** Never change words on a protect list (negations such as no, not, denies; drug names), honour `min_confidence`, and return alternatives instead of silently replacing. `amoxcillin` → `ampicillin` and `no fever` → `to fever` are clinically unsafe.
7. **Add a medical dictionary** (drug names, conditions, lab terms) with counts high enough to beat everyday words, for both English and Malayalam; consider loading it per tenant like the taxonomy.
8. **Fix the bigram load** (`count_index=2`) and copy `apps/nlp/data` into the Docker image.
9. **Decide whether spelling should run on clinical text at all** until 6 and 7 are done. Today it can change meaning while reporting success.
