# TASK-628 Reference — Ambient Clinical Documentation: Published Reliability Expectations

**Researched**: 2026-08-07 · **Sources**: vendor trust/technical documentation, PubMed, CFR/regulator and professional-body guidance. Press reporting is labelled as such.

---

## 1. The headline: there is no published bar

**No vendor and no peer-reviewed study publishes a rate for dropped audio, lost recordings, incomplete transcripts, or session failure.** This was searched for specifically and is a genuine gap, not a search failure.

What exists instead is a *displaced* reliability discourse:

- **Vendors** publish infrastructure availability (Azure 99.9%) and security posture (SOC 2, HIPAA), not **capture** reliability.
- **Academics** measure note *content* quality — omissions, hallucinations, WER — on encounters that already recorded successfully. Successful capture is the unstated precondition of every published study.
- **Regulators** place a completeness duty on the **clinician**, and are silent on the capture layer.

**Consequence for HOPE**: the de-facto standard of care is *"the clinician reviews and signs, so the tool need not guarantee capture."* Publishing an audio-loss / session-integrity metric would put HOPE **ahead of every vendor surveyed**. The bar is being set, not inherited — so the design rationale has to stand on its own reasoning.

---

## 2. ⚠️ The finding that changes the buffering argument

**Koenecke et al., "Careless Whisper: Speech-to-Text Hallucination Harms", FAccT '24** ([DOI](https://doi.org/10.1145/3630106.3658996) · [arXiv:2402.08021](https://arxiv.org/abs/2402.08021)):

- *"roughly 1% of audio transcriptions contained entire hallucinated phrases or sentences which did not exist in any form in the underlying audio."*
- **38% of hallucinations included explicit harms** — perpetuating violence, inaccurate associations, implied false authority.
- Rates were **disproportionately higher for speakers with aphasia**, and **correlated with longer non-vocal durations**.

That last clause is the load-bearing one. **Silence and disfluency are hallucination triggers**, and HOPE runs Whisper.

So the ~20–35 s audio-discard gap identified in [Appendix G §G2](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-zero-downtime-ha.md) is **not merely missing words**. The silence it injects into the stream is an active **fabrication risk** in a clinical note — and the affected population skews toward patients with speech impairments, who are exactly the patients least able to catch a fabricated line in their record.

This upgrades client-side audio buffering from "avoid losing content" to "avoid *generating* content." It is now the strongest single argument in the STT work.

---

## 3. The only vendor publishing anything close to a capture contract

**Microsoft Dragon Copilot** (formerly Nuance DAX) — [transparency whitepaper](https://learn.microsoft.com/en-us/industry/healthcare/dragon-copilot/whitepapers/transparency):

| Factor | Published limit |
|---|---|
| Ambient diarized speakers | ≤ 2 (one primary, others aggregated) |
| Aggregate ambient recording | **75 minutes** per session |
| Network latency | **< 200 ms** for STT; *">250 ms may affect real-time dictation"* |

Microsoft *names* its metrics — WER, accuracy score, latency, uptime — and **publishes no values for any of them**.

The [security whitepaper](https://learn.microsoft.com/en-us/industry/healthcare/dragon-copilot/whitepapers/security) contains the industry's most direct statement on audio loss, and it is an architectural asymmetry:

> **Mobile**: *"If upload connectivity is unavailable, recordings are encrypted locally and automatically uploaded, and deleted from the end user device, once connectivity is restored."*
> **Desktop and web**: *"Do not persist data."*

So the single published precedent for offline buffering is **mobile-only**, and desktop/web explicitly do not buffer. HOPE's SDK is a browser client — i.e. the tier the market leader has decided *not* to protect. Doing so is a differentiator.

Also notable: troubleshooting guidance says *"Don't advise the user to uninstall and reinstall… as it might result in lost edits or ambient recordings"* — an acknowledgment that recordings can be lost, with no rate attached. And **DAX/Dragon Copilot ambient is absent from Microsoft's published SLA uptime reports**; no SLA anywhere covers data loss or capture failure.

**Every other vendor publishes less.** Abridge, Nabla, Suki: certifications only, no uptime figure, no public status page, no interruption behavior. Ambience publishes no trust documentation at all. Retention figures circulating for these vendors come from third-party review sites, not primary sources.

---

## 4. What academia does measure — useful as quality targets, not capture targets

| Study | Finding |
|---|---|
| Anderson et al., *Mayo Clin Proc Digit Health* 2025 ([PMID 41234546](https://doi.org/10.1016/j.mcpdig.2025.100292)) | 5 platforms × 14 encounters. **Mean note error rate 26.3%**; **19.5% of transcript errors propagated into the note**; **avg 3.0 errors/case with moderate-to-severe harm potential** |
| Biro et al., *JMIR* 2025 ([PMID 39869899](https://doi.org/10.2196/64993)) | **70% of notes contained ≥1 error**; mean 2.9/note. **Omission dominant** (83% / 54% of errors by product) |
| Palm et al., *Front Artif Intell* 2025 ([PMID 41199808](https://doi.org/10.3389/frai.2025.1691499)) | **Hallucinations in 31% of ambient notes vs 20% of physician notes** (P=0.01). *Vendor-authored — Suki AI* |
| Ng et al., *BMC Med Inform Decis Mak* 2025 ([PMID 40598136](https://doi.org/10.1186/s12911-025-03061-0)) | Systematic review, 29 studies. **WER 0.087 in controlled dictation to >50% in conversational/multi-speaker** |

That WER range is the most relevant number for HOPE: conversational multi-speaker clinical audio sits at the bad end, which is the regime HOPE operates in.

Topaz et al., *npj Digit Med* 2025 ([PMID 40993221](https://doi.org/10.1038/s41746-025-01895-6)) names the gap directly — *"adoption is outpacing validation and oversight"* — and notes that traceable transcript references (as in AWS HealthScribe) are **emerging practice, not a standard**. HOPE's per-utterance pipeline provenance (TASK-613) is on the right side of that.

---

## 5. Where the legal duty actually lands

**42 CFR § 482.24** (Medicare Conditions of Participation) requires records be *"accurately written, promptly completed, properly filed and retained, and accessible"*, entries *"legible and complete"*, retention ≥5 years. [eCFR](https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-G/part-482/subpart-C/section-482.24)

**It contains no technology carve-out.** If audio is lost and the note is incomplete, the CoP is breached regardless of vendor fault. That duty sits with the provider organization — HOPE's customers — which is precisely why capture reliability is a product concern even though no regulator names it.

- **FDA**: ambient scribes generally sit outside device regulation as administrative/transcription tools. No FDA reliability requirement applies.
- **Joint Commission + CHAI** RUAIH guidance (Sept 2025): governance-level — committees, policies, board reporting. No performance thresholds.
- **AMA**: ambient scribing does not absolve the clinician; the signing physician owns the note.
- **ONC/ASTP HTI-1** §170.315(b)(11): transparency about training data, not runtime reliability.
- **ECRI**: AI ranked **#1 health technology hazard for 2025**; for 2026, *"digital darkness"* (sudden loss of access to electronic systems and patient information) appears on the list.

No AHIMA practice brief specific to ambient scribes was found.

---

## 6. Press reporting — labelled, not load-bearing

AP (Burke & Schellmann, Oct 2024) reported engineers finding Whisper hallucinations in *half* of 100+ hours and in *nearly all* of 26,000 transcripts. **Treat as anecdotal** — an order of magnitude above Koenecke's peer-reviewed ~1%, on unspecified audio.

One reported detail is worth internalizing regardless: **Nabla reportedly deletes the original audio "for data safety reasons," leaving no way to verify a transcript against its source.** HOPE retains audio in MinIO, which makes verification possible — a real advantage, and an argument against any future "delete audio for safety" proposal.

---

## 7. What to take into the design

1. **Buffer client-side audio.** The argument is no longer completeness — it is that silence triggers fabrication (§2), and the affected population is the most vulnerable.
2. **Set and publish a loss budget.** No one else has. TASK-628 proposes ≥95% word recall across a disconnect; that is a proposal to ratify, not an inherited standard.
3. **Keep the audio.** It is what makes a transcript auditable, and at least one major vendor has given that up.
4. **Expect the WER regime to be the hard end** (conversational, multi-speaker, accented), not the 0.087 dictation figure.
5. **Session limits are legitimate.** Microsoft publishes 75 min aggregate; a bounded session with explicit handling beats an unbounded one that degrades silently.
