#!/usr/bin/env python3
"""
HOPE LLM Token-Based End-to-End Latency & Stability Benchmark
=============================================================
Built upon the production client in `scripts/benchmark_llm_hops.py`.

Executes the FULL, authentic clinical consultation pipeline across incremental
transcript token sizes (500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000).

Every token tier executes the EXACT functional stages:
  Stage 1: Session Initialization (Client → Gateway ↔ PostgreSQL)
  Stage 2: Transcript Context Ingestion (Gateway ↔ Context Vault)
  Stage 3: Summary Workflow Dispatch (Gateway ↔ Temporal Workflow Queue)
  Stage 4: Scribe Pipeline Execution:
           ↳ Stage 4.1: NLP Entity Extraction (Gateway ↔ apps/nlp)
           ↳ Stage 4.2: Prompt & Style DNA Assembly (Gateway ↔ apps/api)
           ↳ Stage 4.3: Clinical LLM Note Gen (apps/text ↔ LM Studio GPU)
           ↳ Stage 4.4: Medical Guardrail Gate (Gateway ↔ apps/guardrail)
  Stage 5: Clinical Note Retrieval (Gateway ↔ PostgreSQL)

Evaluates:
  - Total End-to-End Pipeline Latency across token sizes
  - Microservice-by-microservice latency scaling (NLP, Assembly, LLM GPU, Guardrail)
  - Throughput (tokens/second)
  - Prompt & Completion Token Tracking
  - Degradation & Hard Failure Threshold Detection
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
SCRIPTS_DIR = os.path.join(REPO_ROOT, "scripts")
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from benchmark_llm_hops import (
    Colors,
    HopResult,
    HopTimer,
    PipelineHopBenchmark,
    _generate_native_xlsx,
    colored,
)


# --- Realistic Multi-turn Clinical Dialogue Synthesizer ---
def generate_calibrated_clinical_text(target_tokens: int) -> Tuple[str, int, int]:
    """Generates realistic clinical dialogue calibrated to target token count."""
    target_words = int(target_tokens * 0.75)
    
    base_encounter = [
        "Doctor: Good morning Mr. Kumar, please have a seat. What brings you in today?",
        "Patient: Good morning doctor. For the past two hours I have been experiencing severe, crushing pain in my chest that radiates directly down my left shoulder, arm, and into my jaw. I am sweating profusely, feeling dizzy, and unusually out of breath.",
        "Doctor: Do you have any prior history of cardiovascular disease, high blood pressure, or diabetes?",
        "Patient: I was diagnosed with essential hypertension five years ago, for which I take Amlodipine 5mg once daily. I also take Atorvastatin 20mg for hyperlipidemia. My father died suddenly of a myocardial infarction at age 52. I have no known drug allergies.",
        "Doctor: Let us check your vital signs immediately. Your blood pressure is 150/95 mmHg, pulse rate is 88 beats per minute, respiratory rate is 22 breaths per minute, and oxygen saturation is 96% on room air. On examination, your heart sounds are S1 and S2 regular, no audible murmurs, and lungs are clear to auscultation bilaterally.",
        "Patient: Doctor, is this an ongoing heart attack?",
        "Doctor: Based on your acute chest pain, radiation pattern, hypertension, and significant family history, our primary clinical assessment is Acute Coronary Syndrome, and we must urgently rule out acute myocardial infarction.",
        "Doctor: Here is our immediate plan of care: I am administering Aspirin 300mg stat to be chewed immediately. We will obtain a stat 12-lead ECG right now, draw blood for serial cardiac Troponin-I and metabolic panels, place you on continuous cardiac telemetry monitoring, and arrange an urgent cardiology consultation for admission.",
        "Patient: Understood doctor. I am chewing the aspirin right away. Thank you."
    ]

    clinical_modules = [
        [
            "Doctor: The bedside 12-lead ECG is complete. It demonstrates sinus rhythm at 86 bpm with 2 millimeter ST-segment depressions across leads V4 through V6 and subtle T-wave inversions in lead aVL, indicative of subendocardial myocardial ischemia.",
            "Patient: Does that confirm the blockage doctor?",
            "Doctor: It confirms active myocardial strain. We also received the preliminary point-of-care cardiac biomarker panel. High-sensitivity Troponin-I is elevated at 142 ng/L, with normal reference being below 14 ng/L. Serum creatinine is 1.05 mg/dL, potassium is 4.1 mEq/L, and blood glucose is 138 mg/dL.",
            "Patient: What do the elevated troponin numbers mean?",
            "Doctor: Troponin is a specific protein released by heart muscle cells during acute ischemic injury. The combination of your ischemic symptoms, ECG ST-depressions, and elevated Troponin-I establishes the diagnosis of Non-ST-Elevation Myocardial Infarction (NSTEMI)."
        ],
        [
            "Doctor (Cardiology Specialist): Hello Mr. Kumar, I am Dr. Sen from interventional cardiology reviewing your case. Based on the GRACE risk score of 128 and elevated cardiac enzymes, you fall into the high-risk category warranting early invasive coronary angiography within 24 hours.",
            "Patient: What kind of procedure is coronary angiography, Dr. Sen?",
            "Doctor (Cardiology Specialist): We will introduce a thin catheter through your right radial artery at the wrist under local anesthesia. We inject radiopaque contrast into your coronary arteries to visualize exactly which vessel is occluded or stenosed. If indicated, we will perform percutaneous coronary intervention with a drug-eluting stent to restore complete blood flow.",
            "Patient: Are there any alternatives to stenting?",
            "Doctor (Cardiology Specialist): Medical management alone carries a significantly higher risk of recurrent infarction and heart failure. Catheterization is the gold standard of care for acute coronary syndromes."
        ],
        [
            "Doctor: Let us review your acute medical therapies while you await transfer to the Cardiac Intensive Care Unit. In addition to the chewable Aspirin 300mg, we are administering a loading dose of Ticagrelor 180mg orally.",
            "Patient: What does Ticagrelor do differently from aspirin?",
            "Doctor: Aspirin inhibits cyclooxygenase-1, while Ticagrelor is a potent P2Y12 platelet inhibitor. Dual antiplatelet therapy provides synergistic protection against acute stent thrombosis and coronary artery reocclusion.",
            "Doctor: We have also initiated therapeutic anticoagulation with subcutaneous Enoxaparin 1 mg/kg every 12 hours, sublingual nitroglycerin 0.4mg as needed for ischemic chest pain relief, and an intravenous infusion of Metoprolol tartrate to achieve a target resting heart rate between 60 and 70 beats per minute.",
            "Patient: My chest tightness is gradually improving from an 8 out of 10 down to approximately 3 out of 10 after the sublingual nitroglycerin."
        ],
        [
            "Doctor: While preparing the transfer documentation, let us document your comprehensive review of systems. Any history of gastrointestinal ulceration, upper GI bleeding, or melena?",
            "Patient: None doctor. I had an elective laparoscopic cholecystectomy eight years ago without any postoperative bleeding complications.",
            "Doctor: Any history of peripheral vascular disease, intermittent claudication, cerebrovascular accident, or transient ischemic attacks?",
            "Patient: No strokes or mini-strokes. Sometimes my feet get mildly swollen after standing for prolonged periods, but no leg ulcers or calf claudication.",
            "Doctor: On further cardiovascular exam: Jugular venous pressure is normal at 3 cm above the sternal angle with no jugular venous distension. Peripheral pulses including radial, dorsalis pedis, and posterior tibial are 2+ symmetrical bilaterally. No peripheral pedal edema observed."
        ],
        [
            "Nurse Coordinator: Doctor, bedside vitals update at fifteen minutes: Blood pressure is now 134/82 mmHg, heart rate is 72 bpm in sinus rhythm, SpO2 is 98% on 2 liters nasal cannula. No ectopy or premature ventricular contractions on continuous lead II telemetry.",
            "Doctor: Excellent. Please ensure dual wide-bore 18-gauge intravenous access in the left upper extremity, keep the patient strict NPO except for essential medications, and confirm that type and screen with crossmatch for two units of packed red blood cells has been sent to the blood bank.",
            "Nurse Coordinator: Acknowledged. Consent forms for cardiac catheterization, coronary angiogram, possible percutaneous coronary intervention with drug-eluting stents, and emergency intra-aortic balloon pump backup have been fully explained and are ready for patient signature."
        ],
        [
            "Doctor: For the clinical record, we have thoroughly considered and ruled out acute differential diagnoses: Acute aortic dissection is unlikely given symmetrical upper extremity blood pressures, absence of tearing back pain, and normal mediastinal silhouette on bedside portable chest radiograph.",
            "Doctor: Pulmonary embolism is deemed low probability based on a Wells score of 1.5, absence of unilateral lower extremity deep vein thrombosis, and lack of sinus tachycardia or S1Q3T3 pattern on ECG.",
            "Doctor: Acute pericarditis is excluded due to the absence of diffuse concave ST-elevations, lack of PR-segment depressions, and absence of pericardial friction rub on cardiac auscultation.",
            "Patient: Thank you for being so thorough doctor. It gives my family and me peace of mind knowing all possibilities were evaluated."
        ]
    ]

    dialogue = list(base_encounter)
    current_words = sum(len(line.split()) for line in dialogue)

    module_idx = 0
    while current_words < target_words:
        mod = clinical_modules[module_idx % len(clinical_modules)]
        for line in mod:
            dialogue.append(line)
            current_words += len(line.split())
            if current_words >= target_words:
                break
        module_idx += 1

    full_transcript = "\n".join(dialogue)
    actual_words = sum(len(line.split()) for line in dialogue)
    actual_chars = len(full_transcript)
    return full_transcript, actual_words, actual_chars


@dataclass
class TierPipelineResult:
    target_tokens: int
    prompt_words: int
    prompt_chars: int
    consultation_id: str
    job_id: str
    session_init_ms: float
    transcript_ingest_ms: float
    workflow_dispatch_ms: float
    pipeline_exec_ms: float
    nlp_extract_ms: float
    prompt_assembly_ms: float
    llm_gpu_ms: float
    guardrail_gate_ms: float
    note_retrieval_ms: float
    total_e2e_ms: float
    actual_prompt_tokens: Optional[int]
    completion_tokens: Optional[int]
    throughput_tps: Optional[float]
    status_label: str  # PASS, DEGRADED, FAIL
    error_message: Optional[str] = None
    is_success: bool = True


class TokenConsultationBenchmark(PipelineHopBenchmark):
    """Extends PipelineHopBenchmark to execute token-scaling ladder across all consultation stages."""

    def __init__(
        self,
        deployed_url: str = "https://api-vox2.arcaai.com",
        username: str = "arcaai_doctor",
        password: str = "password123",
        tenant_key: str = "ARCAAI",
        token: str = "",
        agent_slug: str = "general-medicine-summarization",
        gen_model: str = "gemma-4-e2b-it-qat",
        timeout_s: float = 90.0,
        output_dir: str = "scripts/token_benchmark",
    ):
        super().__init__(
            deployed_url=deployed_url,
            username=username,
            password=password,
            tenant_key=tenant_key,
            token=token,
            agent_slug=agent_slug,
            gen_model=gen_model,
            timeout_s=timeout_s,
        )
        self.output_dir = output_dir

    def run_full_consultation_tier(
        self,
        target_tokens: int,
        baseline_e2e_ms: Optional[float] = None,
    ) -> TierPipelineResult:
        """Runs the entire consultation pipeline and microservices for one token scale."""
        transcript, words, chars = generate_calibrated_clinical_text(target_tokens)
        pat_id = f"pat-benchmark-{target_tokens}tok-{int(time.time())}"

        print(f"\n{Colors.BOLD}{'='*80}{Colors.RESET}")
        print(f"  {Colors.CYAN}{Colors.BOLD}TESTING TIER: {target_tokens} TOKENS{Colors.RESET} ({words} words, {chars} characters)")
        print(f"{Colors.BOLD}{'='*80}{Colors.RESET}")

        # Stage 1: Session Initialization
        print(f"  {colored('[Stage 1]', Colors.BOLD)} Opening {colored('Consultation Session', Colors.CYAN)} (Gateway ↔ PostgreSQL) ... ", end="", flush=True)
        hop1, cid = self.test_real_hop1_open_consultation(pat_id)
        if not hop1.success or not cid:
            print(f"[{colored('FAIL', Colors.RED)}] ({hop1.error_message})")
            return TierPipelineResult(
                target_tokens=target_tokens, prompt_words=words, prompt_chars=chars,
                consultation_id="", job_id="",
                session_init_ms=hop1.total_ms, transcript_ingest_ms=0, workflow_dispatch_ms=0,
                pipeline_exec_ms=0, nlp_extract_ms=0, prompt_assembly_ms=0,
                llm_gpu_ms=0, guardrail_gate_ms=0, note_retrieval_ms=0,
                total_e2e_ms=hop1.total_ms, actual_prompt_tokens=None, completion_tokens=None,
                throughput_tps=None, status_label="FAIL (Session Init)", error_message=hop1.error_message, is_success=False
            )

        # Stage 2: Transcript Context Ingestion
        print(f"  {colored('[Stage 2]', Colors.BOLD)} Ingesting {colored('Transcript Context', Colors.CYAN)} (Gateway ↔ Context Vault) ... ", end="", flush=True)
        hop2, ctx_id = self.test_real_hop2_ingest_transcript(cid, transcript)
        if not hop2.success:
            print(f"[{colored('FAIL', Colors.RED)}] ({hop2.error_message})")
            return TierPipelineResult(
                target_tokens=target_tokens, prompt_words=words, prompt_chars=chars,
                consultation_id=cid, job_id="",
                session_init_ms=hop1.total_ms, transcript_ingest_ms=hop2.total_ms, workflow_dispatch_ms=0,
                pipeline_exec_ms=0, nlp_extract_ms=0, prompt_assembly_ms=0,
                llm_gpu_ms=0, guardrail_gate_ms=0, note_retrieval_ms=0,
                total_e2e_ms=hop1.total_ms + hop2.total_ms, actual_prompt_tokens=None, completion_tokens=None,
                throughput_tps=None, status_label="FAIL (Transcript Ingest)", error_message=hop2.error_message, is_success=False
            )

        # Stage 3: Summary Workflow Dispatch
        print(f"  {colored('[Stage 3]', Colors.BOLD)} Dispatching {colored('Summary Workflow', Colors.CYAN)} (Gateway ↔ Temporal Queue) ... ", end="", flush=True)
        hop3, job_id = self.test_real_hop3_dispatch_summary(cid, ctx_id)
        if not hop3.success:
            print(f"[{colored('FAIL', Colors.RED)}] ({hop3.error_message})")
            return TierPipelineResult(
                target_tokens=target_tokens, prompt_words=words, prompt_chars=chars,
                consultation_id=cid, job_id="",
                session_init_ms=hop1.total_ms, transcript_ingest_ms=hop2.total_ms, workflow_dispatch_ms=hop3.total_ms,
                pipeline_exec_ms=0, nlp_extract_ms=0, prompt_assembly_ms=0,
                llm_gpu_ms=0, guardrail_gate_ms=0, note_retrieval_ms=0,
                total_e2e_ms=hop1.total_ms + hop2.total_ms + hop3.total_ms, actual_prompt_tokens=None, completion_tokens=None,
                throughput_tps=None, status_label="FAIL (Workflow Dispatch)", error_message=hop3.error_message, is_success=False
            )

        # Stage 4: Scribe Pipeline Execution (NLP + Assembly + LM Studio GPU + Guardrail Gate)
        hop4 = self.test_real_hop4_poll_pipeline_execution(job_id)

        # Stage 4 Microservice Sub-stages
        subhops = self.test_real_hop4_subhops(transcript, hop4.total_ms)

        # Stage 5: Clinical Note Retrieval
        hop5 = self.test_real_hop5_fetch_latest_summary(cid)

        # Extract metrics
        t_nlp = next((sh.total_ms for sh in subhops if str(sh.hop_number) == "4.1"), 0.0)
        t_asm = next((sh.total_ms for sh in subhops if str(sh.hop_number) == "4.2"), 0.0)
        t_llm = next((sh.total_ms for sh in subhops if str(sh.hop_number) == "4.3"), 0.0)
        t_grd = next((sh.total_ms for sh in subhops if str(sh.hop_number) == "4.4"), 0.0)

        sh_llm = next((sh for sh in subhops if str(sh.hop_number) == "4.3"), None)
        prompt_tok = sh_llm.tokens_in if sh_llm else hop4.tokens_in
        comp_tok = sh_llm.tokens_out if sh_llm else hop4.tokens_out
        tps = sh_llm.tokens_per_sec if sh_llm else hop4.tokens_per_sec

        total_e2e = hop1.total_ms + hop2.total_ms + hop3.total_ms + hop4.total_ms + hop5.total_ms

        is_success = hop1.success and hop2.success and hop3.success and hop4.success and hop5.success
        status_label = "PASS"
        if not is_success:
            failed_stage = "Pipeline Execution" if not hop4.success else ("Note Retrieval" if not hop5.success else "Unknown")
            status_label = f"FAIL ({failed_stage})"
        elif baseline_e2e_ms and total_e2e > baseline_e2e_ms * 1.50:
            status_label = "DEGRADED"

        return TierPipelineResult(
            target_tokens=target_tokens,
            prompt_words=words,
            prompt_chars=chars,
            consultation_id=cid,
            job_id=job_id,
            session_init_ms=hop1.total_ms,
            transcript_ingest_ms=hop2.total_ms,
            workflow_dispatch_ms=hop3.total_ms,
            pipeline_exec_ms=hop4.total_ms,
            nlp_extract_ms=t_nlp,
            prompt_assembly_ms=t_asm,
            llm_gpu_ms=t_llm,
            guardrail_gate_ms=t_grd,
            note_retrieval_ms=hop5.total_ms,
            total_e2e_ms=total_e2e,
            actual_prompt_tokens=prompt_tok,
            completion_tokens=comp_tok,
            throughput_tps=tps,
            status_label=status_label,
            error_message=hop4.error_message or hop5.error_message,
            is_success=is_success,
        )

    def run_benchmark_ladder(self, tiers: List[int]) -> List[TierPipelineResult]:
        """Runs the benchmark ladder across all token tiers."""
        print(f"\n{Colors.BOLD}{Colors.HEADER}{'='*80}{Colors.RESET}")
        print(f"{Colors.BOLD}{Colors.HEADER}    HOPE FULL-PIPELINE TOKEN BENCHMARK SUITE ({self.deployed_url}){Colors.RESET}")
        print(f"{Colors.BOLD}{Colors.HEADER}{'='*80}{Colors.RESET}")
        print(f"Target URL:     {colored(self.deployed_url, Colors.CYAN)}")
        print(f"Clinician User: {colored(self.username, Colors.GREEN)}")
        print(f"Gen Model:      {colored(self.gen_model, Colors.YELLOW)}")
        print(f"Token Tiers:    {tiers}")
        print(f"Stages Tested:  Stage 1 (Session Init) ➔ Stage 2 (Transcript Ingest) ➔ Stage 3 (Workflow Dispatch) ➔ Stage 4 (Pipeline Exec) ➔ Stage 5 (Note Retrieval)\n")

        # Automatic Authentication
        auth_hop = self.auto_authenticate()
        if not self.token:
            print(f"{colored('Authentication failed. Aborting benchmark.', Colors.RED)}")
            return []

        results: List[TierPipelineResult] = []
        baseline_e2e: Optional[float] = None

        for idx, tier in enumerate(tiers):
            res = self.run_full_consultation_tier(tier, baseline_e2e_ms=baseline_e2e)
            results.append(res)

            if idx == 0 and res.is_success:
                baseline_e2e = res.total_e2e_ms

            time.sleep(1.0)

        self.print_comparative_table(results)
        self.export_comparative_reports(results)
        return results

    def print_comparative_table(self, results: List[TierPipelineResult]) -> None:
        """Renders comprehensive console comparative table."""
        print(f"\n{Colors.BOLD}--- END-TO-END PIPELINE & SERVICE-BY-SERVICE COMPARATIVE BENCHMARK ---{Colors.RESET}\n")
        header = f"{'Tier':<9} | {'Status':<21} | {'Total E2E':<12} | {'Session Init':<12} | {'Context Ing':<12} | {'Queue Disp':<11} | {'Pipeline Exec':<13} | {'NLP Entity':<11} | {'LLM GPU Gen':<11} | {'Note Retr':<10} | {'Throughput':<12}"
        print(header)
        print("-" * len(header))

        for r in results:
            st_color = Colors.GREEN if r.status_label == "PASS" else (Colors.YELLOW if r.status_label == "DEGRADED" else Colors.RED)
            tps_str = f"{r.throughput_tps:.1f} tok/s" if r.throughput_tps else "-"
            print(
                f"{r.target_tokens:<9} | "
                f"{colored(r.status_label, st_color):<30} | "
                f"{r.total_e2e_ms:9.1f}ms | "
                f"{r.session_init_ms:9.1f}ms | "
                f"{r.transcript_ingest_ms:10.1f}ms | "
                f"{r.workflow_dispatch_ms:9.1f}ms | "
                f"{r.pipeline_exec_ms:10.1f}ms | "
                f"{r.nlp_extract_ms:9.1f}ms | "
                f"{r.llm_gpu_ms:9.1f}ms | "
                f"{r.note_retrieval_ms:8.1f}ms | "
                f"{tps_str:<12}"
            )
        print("-" * len(header))

    def export_comparative_reports(self, results: List[TierPipelineResult]) -> Tuple[str, str, str]:
        """Generates Markdown, Excel, and CSV comparative reports with clean stage names."""
        os.makedirs(self.output_dir, exist_ok=True)
        now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        md_path = os.path.join(self.output_dir, "token_benchmark_report.md")
        xlsx_path = os.path.join(self.output_dir, "token_benchmark_results.xlsx")
        csv_path = os.path.join(self.output_dir, "token_benchmark_results.csv")

        # 1. CSV Export
        headers = [
            "Target Tokens", "Prompt Words", "Status", "Total E2E Latency (ms)",
            "Stage 1: Session Init (ms)", "Stage 2: Context Ingest (ms)", "Stage 3: Workflow Dispatch (ms)",
            "Stage 4: Pipeline Exec Total (ms)", "Stage 4.1: NLP Entity Extraction (ms)", "Stage 4.2: Prompt Assembly (ms)",
            "Stage 4.3: LLM GPU Note Gen (ms)", "Stage 4.4: Medical Guardrail Gate (ms)", "Stage 5: Note Retrieval (ms)",
            "Prompt Tokens", "Completion Tokens", "Throughput (tok/s)", "Error Notes"
        ]
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(headers)
            for r in results:
                w.writerow([
                    r.target_tokens, r.prompt_words, r.status_label, round(r.total_e2e_ms, 1),
                    round(r.session_init_ms, 1), round(r.transcript_ingest_ms, 1), round(r.workflow_dispatch_ms, 1),
                    round(r.pipeline_exec_ms, 1), round(r.nlp_extract_ms, 1), round(r.prompt_assembly_ms, 1),
                    round(r.llm_gpu_ms, 1), round(r.guardrail_gate_ms, 1), round(r.note_retrieval_ms, 1),
                    r.actual_prompt_tokens or "", r.completion_tokens or "",
                    round(r.throughput_tps, 1) if r.throughput_tps else "", r.error_message or "Success"
                ])

        # 2. Excel Export
        rows_excel = []
        for r in results:
            rows_excel.append([
                r.target_tokens, r.prompt_words, r.status_label, round(r.total_e2e_ms, 1),
                round(r.session_init_ms, 1), round(r.transcript_ingest_ms, 1), round(r.workflow_dispatch_ms, 1),
                round(r.pipeline_exec_ms, 1), round(r.nlp_extract_ms, 1), round(r.prompt_assembly_ms, 1),
                round(r.llm_gpu_ms, 1), round(r.guardrail_gate_ms, 1), round(r.note_retrieval_ms, 1),
                r.actual_prompt_tokens or "-", r.completion_tokens or "-",
                round(r.throughput_tps, 1) if r.throughput_tps else "-", r.error_message or "Success"
            ])
        _generate_native_xlsx(headers, rows_excel, xlsx_path)

        # 3. Markdown Report
        successful = [r for r in results if r.is_success]
        failed = [r for r in results if not r.is_success]
        safe_capacity = max([r.target_tokens for r in successful if r.status_label == "PASS"], default=0)
        deg_thresh = next((r.target_tokens for r in successful if r.status_label == "DEGRADED"), None)
        fail_thresh = failed[0].target_tokens if failed else None

        md_content = f"""# HOPE LLM Full-Pipeline Token-Based Latency & Stability Report

**Generated:** {now_utc}  
**Target Ingress:** `{self.deployed_url}`  
**Model / Engine:** `{self.gen_model}` via LM Studio GPU  
**Agent Specialization:** `{self.agent_slug}`  
**Pipeline Sequence:** Stage 1 (Session Init) ➔ Stage 2 (Context Ingest) ➔ Stage 3 (Workflow Dispatch) ➔ Stage 4 (Pipeline Execution) ➔ Stage 5 (Clinical Note Retrieval)

---

## 1. Executive Summary & Stability Boundaries

| Metric / Boundary | Value | Operational Assessment |
| :--- | :--- | :--- |
| **Maximum Safe Token Capacity** | **`{safe_capacity} tokens`** | Safe maximum raw transcript input length without risking degradation |
| **Performance Degradation Threshold** | **`{str(deg_thresh) + ' tokens' if deg_thresh else 'None detected'}`** | Point where full E2E latency increases by >50% over baseline |
| **Hard Failure / Crash Threshold** | **`{str(fail_thresh) + ' tokens' if fail_thresh else 'None (All Tiers Passed)'}`** | Exact boundary where any stage or microservice returns an error |
| **Mean Successful E2E Latency** | `{sum(r.total_e2e_ms for r in successful) / max(len(successful), 1):.1f} ms` | Average total time across all 5 stages |
| **Mean GPU Inference Throughput** | `{sum(r.throughput_tps for r in successful if r.throughput_tps) / max(len([r for r in successful if r.throughput_tps]), 1):.1f} tok/s` | GPU generation speed |
| **Tiers Passed / Total** | `{len([r for r in results if r.status_label == 'PASS'])} / {len(results)}` | Full end-to-end pipeline executions |

---

## 2. End-to-End Pipeline Comparative Ladder

| Target Tokens | Prompt Words | Total E2E (ms) | Stage 1: Session Init (ms) | Stage 2: Context Ingest (ms) | Stage 3: Workflow Dispatch (ms) | Stage 4: Pipeline Exec (ms) | Stage 5: Note Retrieval (ms) | Status | Notes |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
"""
        for r in results:
            md_content += f"| `{r.target_tokens}` | {r.prompt_words} | **{r.total_e2e_ms:.1f}** | {r.session_init_ms:.1f} | {r.transcript_ingest_ms:.1f} | {r.workflow_dispatch_ms:.1f} | {r.pipeline_exec_ms:.1f} | {r.note_retrieval_ms:.1f} | **`{r.status_label}`** | {r.error_message or 'Optimal'} |\n"

        md_content += """
---

## 3. Service-by-Service Deep Dive (Stage 4 Microservices)

| Target Tokens | Stage 4.1: NLP Entity Extraction (ms) | Stage 4.2: Prompt Assembly (ms) | Stage 4.3: LLM GPU Note Gen (ms) | Stage 4.4: Medical Guardrail Gate (ms) | In / Out Tokens | Throughput (tok/s) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
"""
        for r in results:
            tok_io = f"{r.actual_prompt_tokens or '-'}/{r.completion_tokens or '-'}"
            tps_val = f"{r.throughput_tps:.1f}" if r.throughput_tps else "-"
            md_content += f"| `{r.target_tokens}` | {r.nlp_extract_ms:.1f} | {r.prompt_assembly_ms:.1f} | {r.llm_gpu_ms:.1f} | {r.guardrail_gate_ms:.1f} | {tok_io} | {tps_val} |\n"

        md_content += f"""
---

## 4. End-to-End Orchestration Architecture

```mermaid
sequenceDiagram
    autonumber
    actor Clinician as Clinician Client
    participant GW as API Gateway (api-vox2)
    participant DB as PostgreSQL Context Vault
    participant Q as Workflow Dispatcher (Temporal)
    participant NLP as apps/nlp (Entity Extraction)
    participant LLM as apps/text ↔ LM Studio (Gemma 4)
    participant GR as apps/guardrail (Medical Sensor Gate)

    Note over Clinician, GW: Stage 1: Client Ingress & Authentication
    Clinician->>GW: POST /api/v1/auth/login
    GW-->>Clinician: 200 OK (Bearer JWT)

    Note over Clinician, DB: Stage 2: Consultation Session Initialization
    Clinician->>GW: POST /api/v1/consultations/open
    GW->>DB: INSERT Consultation Record
    GW-->>Clinician: 201 Created (consultationId)

    Note over Clinician, DB: Stage 3: Transcript Context Ingestion
    Clinician->>GW: POST /api/v1/consultations/{{id}}/context
    GW->>DB: INSERT ContextItem (TRANSCRIPT)
    GW-->>Clinician: 201 Created (contextItemId)

    Note over Clinician, Q: Stage 4: Dispatch Summary Workflow
    Clinician->>GW: POST /api/v1/consultations/{{id}}/summary/async
    GW->>Q: Enqueue HarnessDocWorkflow
    GW-->>Clinician: 201 Accepted (jobId)

    Note over Q, GR: Stage 5: Internal Scribe Pipeline Execution
    Q->>NLP: 5.1 Extract Transcript Entities (SNOMED / ICD-10)
    NLP-->>Q: Coded Entities Resolved
    Q->>GW: 5.2 Assemble Prompt & Style DNA
    GW-->>Q: Structured Clinical Prompts
    Q->>LLM: 5.3 LLM Clinical Note Gen via LM Studio (gemma-4-e2b-it-qat)
    LLM-->>Q: Generated SOAP Clinical Draft
    Q->>GR: 5.4 Medical Guardrail & Groundedness Sensors
    GR-->>Q: Verification PASS
    Q->>DB: 5.5 Persist Verified Draft ContextItem

    Note over Clinician, DB: Stage 6: Clinical Note Retrieval
    Clinician->>GW: GET /api/v1/consultations/{{id}}/summary/latest
    GW->>DB: SELECT Summary ContextItem & Sections
    GW-->>Clinician: 200 OK (10 Structured SOAP Sections)
```

---

## 5. Artifact Deliverables
- **Markdown Report:** [`token_benchmark_report.md`](file://{os.path.abspath(md_path)})
- **Excel Workbook:** [`token_benchmark_results.xlsx`](file://{os.path.abspath(xlsx_path)})
- **Raw CSV Data:** [`token_benchmark_results.csv`](file://{os.path.abspath(csv_path)})
"""

        with open(md_path, "w", encoding="utf-8") as f:
            f.write(md_content)

        # Sync to Antigravity brain artifact directory
        artifact_dir = "/Users/apple/.gemini/antigravity/brain/72d4fab8-84e5-4c24-a78f-f9245d206007"
        if os.path.exists(artifact_dir):
            try:
                with open(os.path.join(artifact_dir, "token_benchmark_report.md"), "w", encoding="utf-8") as af:
                    af.write(md_content)
            except Exception:
                pass

        print(f"\n{colored('--- BENCHMARK DELIVERABLES GENERATED ---', Colors.BOLD)}")
        print(f"  📊 Excel Workbook:  {colored(os.path.abspath(xlsx_path), Colors.CYAN)}")
        print(f"  📝 Markdown Report: {colored(os.path.abspath(md_path), Colors.CYAN)}")
        print(f"  📁 Raw CSV Export:   {colored(os.path.abspath(csv_path), Colors.CYAN)}")

        return md_path, xlsx_path, csv_path


# --- CLI Interface ---
def main() -> None:
    parser = argparse.ArgumentParser(description="HOPE Full-Pipeline Token-Based Latency & Stability Benchmark")
    parser.add_argument("--deployed-url", default="https://api-vox2.arcaai.com", help="Base URL of deployed API gateway")
    parser.add_argument("--username", default="arcaai_doctor", help="Clinician username for auto-auth")
    parser.add_argument("--password", default="password123", help="Clinician password")
    parser.add_argument("--tenant-key", default="ARCAAI", help="Tenant key")
    parser.add_argument("--token", default="", help="Optional pre-existing JWT token")
    parser.add_argument("--agent-slug", default="general-medicine-summarization", help="Summarization agent slug")
    parser.add_argument("--gen-model", default="gemma-4-e2b-it-qat", help="Generation model name")
    parser.add_argument("--timeout", type=float, default=90.0, help="Per-request timeout in seconds")
    parser.add_argument("--token-tiers", default="500,1000,1500,2000,2500,3000,3500,4000,4500,5000", help="Comma-separated token tiers")
    parser.add_argument("--output-dir", default="scripts/token_benchmark", help="Directory where reports are saved")

    args = parser.parse_args()

    tiers = [int(x.strip()) for x in args.token_tiers.split(",") if x.strip().isdigit()]
    if not tiers:
        tiers = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000]

    runner = TokenConsultationBenchmark(
        deployed_url=args.deployed_url,
        username=args.username,
        password=args.password,
        tenant_key=args.tenant_key,
        token=args.token,
        agent_slug=args.agent_slug,
        gen_model=args.gen_model,
        timeout_s=args.timeout,
        output_dir=args.output_dir,
    )
    runner.run_benchmark_ladder(tiers)


if __name__ == "__main__":
    main()
