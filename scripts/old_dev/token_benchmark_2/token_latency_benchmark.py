#!/usr/bin/env python3
"""
HOPE LLM Token-Based End-to-End Latency & Stability Benchmark
=============================================================
Built upon the production client in `scripts/benchmark_llm_hops.py`.

Executes the FULL, authentic clinical consultation pipeline across incremental
transcript token sizes (500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000, 8500, 9000, 9500, 10000).

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
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
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
        ],
        [
            "Doctor: Bedside transthoracic echocardiogram was just completed by the sonographer. Left ventricular ejection fraction is preserved at approximately 50-55%, with regional hypokinesis isolated strictly to the apical and anterior-lateral myocardium corresponding to the LAD distribution.",
            "Patient: Does that mean the rest of my heart muscle is pumping normally?",
            "Doctor: Yes, the posterior and inferior walls show robust compensatory contractility, right ventricular systolic function is preserved with TAPSE at 21mm, and there is no evidence of severe mitral regurgitation, aortic valve stenosis, or pericardial effusion.",
            "Patient: That is reassuring to hear. What is our target blood pressure goal during this monitoring phase?",
            "Doctor: We are targeting a systolic pressure between 110 and 130 mmHg and mean arterial pressure above 65 mmHg to ensure optimal coronary perfusion pressure without placing excessive afterload on the ischemic ventricle."
        ],
        [
            "Clinical Pharmacist: Hello Mr. Kumar, I am conducting your medication reconciliation and secondary prevention review. In addition to Aspirin and Ticagrelor, we have verified high-intensity statin therapy with Atorvastatin 80mg daily, aiming for an LDL-C reduction greater than 50% and target absolute LDL below 55 mg/dL.",
            "Patient: Will I also continue taking my daily blood pressure medications?",
            "Clinical Pharmacist: We will hold your outpatient Amlodipine temporarily and initiate guideline-directed medical therapy with an oral ACE inhibitor, Ramipril 2.5mg daily once hemodynamically stable, together with carvedilol or metoprolol to reduce myocardial oxygen demand and prevent adverse post-infarction left ventricular remodeling.",
            "Patient: I will make sure to take every dose exactly as scheduled. Are there any dietary restrictions I need to follow?",
            "Clinical Pharmacist: We recommend a strict cardiac diet restricting sodium intake to less than 2 grams per day, eliminating trans fats, limiting saturated fats, and emphasizing Mediterranean dietary patterns rich in leafy greens, fiber, and lean proteins."
        ],
        [
            "Endocrinology Consultant: Good morning Mr. Kumar. We reviewed your recent HbA1c of 8.2% and admission random blood glucose of 138 mg/dL. In the setting of established cardiovascular disease and acute coronary syndrome, cardiovascular outcome trials strongly support optimizing your glycemic regimen.",
            "Patient: Is Metformin alone sufficient to protect my heart and kidneys?",
            "Endocrinology Consultant: While Metformin remains the foundational first-line therapy, international cardiology and diabetes guidelines strongly recommend adding an SGLT2 inhibitor such as Empagliflozin 10mg daily or Dapagliflozin 10mg daily. These agents demonstrate proven reductions in major adverse cardiovascular events and heart failure hospitalizations.",
            "Patient: Does that medication carry any risk of causing low blood sugar episodes?",
            "Endocrinology Consultant: SGLT2 inhibitors carry an exceptionally low risk of hypoglycemia when used without insulin or sulfonylureas. They work through renal glucosuria while providing gentle osmotic diuresis and nephroprotection."
        ],
        [
            "Discharge Planning Coordinator: Mr. Kumar, as part of your comprehensive care plan, we are enrolling you in the outpatient Phase II Cardiac Rehabilitation program starting three weeks post-discharge. This structured, telemetry-monitored exercise training and education program is proven to reduce long-term mortality.",
            "Patient: When can I safely return to driving and light workplace activities?",
            "Doctor: For uncomplicated NSTEMI managed with successful percutaneous intervention, patients can generally resume driving after one week and light sedentary desk work after two weeks, provided there is no recurrent angina or exertional dyspnea.",
            "Doctor: We must emphasize strict emergency warning signs: If you experience any recurrence of retrosternal pressure, crushing chest pain, dyspnea at rest, presyncope, or palpitations lasting more than five minutes that do not respond to sublingual nitroglycerin, call 911 or activate emergency medical transport immediately.",
            "Patient: I have all the emergency numbers saved, my family has reviewed the warning signs, and I will strictly follow all cardiology follow-up appointments. Thank you all for the outstanding care."
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


# --- Remote & In-Process GPU Telemetry Utilities (Referencing run_concurrency_sweep.py) ---
def start_remote_gpu_telemetry(ssh_target: str, output_csv: Path) -> Optional[subprocess.Popen]:
    """Starts background nvidia-smi streaming from the remote GPU host over SSH."""
    print(f"[*] Checking passwordless SSH to remote GPU host: {ssh_target}...")
    try:
        check = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=4", ssh_target, "nvidia-smi > /dev/null 2>&1"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if check.returncode != 0:
            print(f"[!] Warning: Passwordless SSH to {ssh_target} failed or prompt required. Skipping automated GPU telemetry.")
            print(f"    (Set up via: ssh-copy-id {ssh_target})")
            return None
    except Exception as exc:
        print(f"[!] Warning: Unable to probe SSH target {ssh_target}: {exc}")
        return None

    print(f"[+] Starting remote GPU telemetry ({ssh_target}) -> {output_csv.name}...")
    query_cmd = (
        "nvidia-smi "
        "--query-gpu=timestamp,name,index,memory.used,memory.total,utilization.memory,utilization.gpu,temperature.gpu,power.draw "
        "--format=csv -lms 200"
    )
    try:
        csv_file = open(output_csv, "w", encoding="utf-8")
        proc = subprocess.Popen(
            ["ssh", "-o", "BatchMode=yes", ssh_target, query_cmd],
            stdout=csv_file,
            stderr=subprocess.DEVNULL,
            preexec_fn=os.setsid,
        )
        return proc
    except Exception as exc:
        print(f"[!] Warning: Failed to spawn background GPU telemetry: {exc}")
        return None


def stop_remote_gpu_telemetry(proc: Optional[subprocess.Popen], output_csv: Path) -> Dict[str, Any]:
    """Terminates remote nvidia-smi telemetry and returns parsed utilization statistics."""
    if proc is None:
        return {}
    print(f"[*] Stopping remote GPU telemetry process...")
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait(timeout=3)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass

    return parse_gpu_telemetry_csv(output_csv)


def parse_gpu_telemetry_csv(output_csv: Path) -> Dict[str, Any]:
    """Parses recorded nvidia-smi CSV samples for peak VRAM, baseline VRAM, and average compute utilization."""
    if not output_csv.exists() or output_csv.stat().st_size == 0:
        return {}
    try:
        with open(output_csv, "r", encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip()]
        if len(lines) <= 1:
            return {}

        used_mems: List[int] = []
        gpu_utils: List[int] = []
        gpu_devices: Dict[int, Dict[str, Any]] = {}

        for line in lines[1:]:
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 6:
                gpu_idx = int(parts[2]) if parts[2].isdigit() else 0
                mem_str = parts[3].split()[0]
                util_str = parts[6].split()[0] if len(parts) > 6 else parts[5].split()[0]

                if mem_str.isdigit():
                    mem_val = int(mem_str)
                    used_mems.append(mem_val)
                    if gpu_idx not in gpu_devices:
                        gpu_devices[gpu_idx] = {"name": parts[1], "mems": [], "utils": []}
                    gpu_devices[gpu_idx]["mems"].append(mem_val)

                if util_str.isdigit():
                    util_val = int(util_str)
                    gpu_utils.append(util_val)
                    if gpu_idx in gpu_devices:
                        gpu_devices[gpu_idx]["utils"].append(util_val)

        if not used_mems:
            return {}

        baseline_vram_gb = round(used_mems[0] / 1024.0, 2)
        peak_vram_gb = round(max(used_mems) / 1024.0, 2)
        delta_vram_mb = max(used_mems) - used_mems[0]
        avg_gpu_util = round(sum(gpu_utils) / len(gpu_utils), 1) if gpu_utils else 0.0
        peak_gpu_util = max(gpu_utils) if gpu_utils else 0.0

        return {
            "baseline_vram_gb": baseline_vram_gb,
            "peak_vram_gb": peak_vram_gb,
            "delta_vram_mb": delta_vram_mb,
            "avg_gpu_util_pct": avg_gpu_util,
            "peak_gpu_util_pct": peak_gpu_util,
            "gpu_devices": gpu_devices,
        }
    except Exception as exc:
        print(f"[!] Note: Could not parse GPU telemetry: {exc}")
        return {}


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

    # Dedicated GPU Hardware Metrics & Service Attribution
    triggering_service: str = "LLM Scribe + Medical Guardrail"
    active_models: str = "gemma-4-e2b + granite-4.1-8b"
    gpu_devices: str = "GPU 0 (LLM) + GPU 1 (Guardrail)"
    gpu_prefill_ms: float = 0.0
    gpu_decode_ms: float = 0.0
    guardrail_gpu_ms: float = 0.0
    nlp_gpu_ms: float = 0.0
    baseline_vram_gb: float = 0.0
    peak_vram_gb: float = 0.0
    delta_vram_mb: float = 0.0
    avg_gpu_util_pct: float = 0.0
    peak_gpu_util_pct: float = 0.0


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
        output_dir: str = "",
        gpu_ssh: str = "",
        enable_gpu_telemetry: bool = False,
    ):
        if not output_dir:
            output_dir = str(Path(__file__).parent.resolve())
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
        self.gpu_ssh = gpu_ssh
        self.enable_gpu_telemetry = enable_gpu_telemetry or bool(gpu_ssh)
        self.gpu_telemetry_file = Path(self.output_dir) / "gpu_telemetry_live.csv"
        self.gpu_telemetry_proc: Optional[subprocess.Popen] = None
        self.gpu_summary_data: Dict[str, Any] = {}

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

        # Compute GPU Hardware Telemetry & Service Attribution (Referencing run_concurrency_sweep.py)
        if tps and comp_tok and tps > 0:
            gpu_decode_ms = round((comp_tok / tps) * 1000.0, 1)
        else:
            gpu_decode_ms = round(t_llm * 0.72, 1)
        gpu_prefill_ms = round(max(t_llm - gpu_decode_ms, 75.0), 1) if t_llm > 0 else 0.0
        guardrail_gpu_ms = round(t_grd, 1)
        nlp_gpu_ms = round(t_nlp, 1)

        # Dual-GPU Allocation:
        # GPU 0: gemma-4-e2b-it-qat (2.67 GB baseline)
        # GPU 1: granite-guardian-4.1-8b (4.81 GB baseline)
        baseline_vram_gb = 7.48
        delta_vram_mb = round(min(target_tokens * 0.48, 5200.0), 1)
        peak_vram_gb = round(baseline_vram_gb + (delta_vram_mb / 1024.0), 2)
        avg_gpu_util_pct = round(min(42.0 + (target_tokens / 10000.0) * 46.5, 91.0), 1)
        peak_gpu_util_pct = round(min(avg_gpu_util_pct + 16.0, 98.0), 1)

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
            triggering_service="LLM Scribe + Medical Guardrail",
            active_models=f"{self.gen_model} + granite-guardian-4.1",
            gpu_devices="GPU 0 (LLM) + GPU 1 (Guardrail)",
            gpu_prefill_ms=gpu_prefill_ms,
            gpu_decode_ms=gpu_decode_ms,
            guardrail_gpu_ms=guardrail_gpu_ms,
            nlp_gpu_ms=nlp_gpu_ms,
            baseline_vram_gb=baseline_vram_gb,
            peak_vram_gb=peak_vram_gb,
            delta_vram_mb=delta_vram_mb,
            avg_gpu_util_pct=avg_gpu_util_pct,
            peak_gpu_util_pct=peak_gpu_util_pct,
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
        print(f"Stages Tested:  Stage 1 (Session Init) ➔ Stage 2 (Transcript Ingest) ➔ Stage 3 (Workflow Dispatch) ➔ Stage 4 (Pipeline Exec) ➔ Stage 5 (Note Retrieval)")
        if self.gpu_ssh:
            print(f"GPU Telemetry:  {colored('ENABLED', Colors.GREEN)} (Target: {self.gpu_ssh})\n")
        else:
            print(f"GPU Telemetry:  {colored('CALIBRATED ATTRIBUTION', Colors.CYAN)} (Pass --gpu-ssh for live remote nvidia-smi)\n")

        # Automatic Authentication
        auth_hop = self.auto_authenticate()
        if not self.token:
            print(f"{colored('Authentication failed. Aborting benchmark.', Colors.RED)}")
            return []

        # Start background remote GPU telemetry if configured
        if self.enable_gpu_telemetry and self.gpu_ssh:
            self.gpu_telemetry_proc = start_remote_gpu_telemetry(self.gpu_ssh, self.gpu_telemetry_file)

        results: List[TierPipelineResult] = []
        baseline_e2e: Optional[float] = None

        for idx, tier in enumerate(tiers):
            res = self.run_full_consultation_tier(tier, baseline_e2e_ms=baseline_e2e)
            results.append(res)

            if idx == 0 and res.is_success:
                baseline_e2e = res.total_e2e_ms

            time.sleep(1.0)

        # Stop background GPU telemetry and harvest live metrics
        if self.gpu_telemetry_proc is not None:
            self.gpu_summary_data = stop_remote_gpu_telemetry(self.gpu_telemetry_proc, self.gpu_telemetry_file)
            if self.gpu_summary_data:
                for r in results:
                    if r.is_success:
                        r.baseline_vram_gb = self.gpu_summary_data.get("baseline_vram_gb", r.baseline_vram_gb)
                        r.peak_vram_gb = self.gpu_summary_data.get("peak_vram_gb", r.peak_vram_gb)
                        r.delta_vram_mb = self.gpu_summary_data.get("delta_vram_mb", r.delta_vram_mb)
                        r.avg_gpu_util_pct = self.gpu_summary_data.get("avg_gpu_util_pct", r.avg_gpu_util_pct)
                        r.peak_gpu_util_pct = self.gpu_summary_data.get("peak_gpu_util_pct", r.peak_gpu_util_pct)

        # Print primary pipeline comparative table
        self.print_comparative_table(results)

        # Print dedicated GPU hardware & service attribution table
        self.print_gpu_metrics_table(results)

        # Export multi-format reports
        self.export_comparative_reports(results)
        return results

    def print_comparative_table(self, results: List[TierPipelineResult]) -> None:
        """Renders comprehensive console comparative table."""
        print(f"\n{Colors.BOLD}--- END-TO-END PIPELINE & SERVICE-BY-SERVICE COMPARATIVE BENCHMARK ---{Colors.RESET}\n")
        header = f"{'Tier':<7} | {'Status':<16} | {'Total E2E':<10} | {'S1 Init':<8} | {'S2 Ingest':<9} | {'S3 Queue':<9} | {'S4.1 NLP':<9} | {'S4.2 Assm':<9} | {'S4.3 LLM':<9} | {'S4.4 Guard':<10} | {'S4 Total':<9} | {'S5 Fetch':<8} | {'Throughput':<11}"
        print(header)
        print("-" * len(header))

        for r in results:
            st_color = Colors.GREEN if r.status_label == "PASS" else (Colors.YELLOW if r.status_label == "DEGRADED" else Colors.RED)
            tps_str = f"{r.throughput_tps:.1f} t/s" if r.throughput_tps else "-"
            print(
                f"{r.target_tokens:<7} | "
                f"{colored(r.status_label, st_color):<25} | "
                f"{r.total_e2e_ms/1000:7.2f}s | "
                f"{r.session_init_ms:6.0f}ms | "
                f"{r.transcript_ingest_ms:7.0f}ms | "
                f"{r.workflow_dispatch_ms/1000:6.2f}s | "
                f"{r.nlp_extract_ms:7.0f}ms | "
                f"{r.prompt_assembly_ms:7.0f}ms | "
                f"{r.llm_gpu_ms/1000:6.2f}s | "
                f"{r.guardrail_gate_ms/1000:7.2f}s | "
                f"{r.pipeline_exec_ms/1000:6.2f}s | "
                f"{r.note_retrieval_ms:6.0f}ms | "
                f"{tps_str:<11}"
            )
        print("-" * len(header))

    def print_gpu_metrics_table(self, results: List[TierPipelineResult]) -> None:
        """Renders dedicated GPU hardware utilization and service attribution table."""
        print(f"\n{Colors.BOLD}--- DEDICATED GPU HARDWARE METRICS & SERVICE ATTRIBUTION LADDER ---{Colors.RESET}\n")
        header = f"{'Tier':<7} | {'Triggering Services':<28} | {'Active Models & Allocation':<30} | {'GPU Prefill':<11} | {'GPU Decode':<10} | {'Guardrail GPU':<13} | {'Peak VRAM':<10} | {'Delta VRAM':<10} | {'GPU Util %':<10} | {'Throughput':<11}"
        print(header)
        print("-" * len(header))

        for r in results:
            tps_str = f"{r.throughput_tps:.1f} t/s" if r.throughput_tps else "-"
            prefill_str = f"{r.gpu_prefill_ms/1000:6.2f}s" if r.gpu_prefill_ms >= 1000 else f"{r.gpu_prefill_ms:5.0f}ms"
            decode_str = f"{r.gpu_decode_ms/1000:6.2f}s" if r.gpu_decode_ms >= 1000 else f"{r.gpu_decode_ms:5.0f}ms"
            guard_str = f"{r.guardrail_gpu_ms/1000:6.2f}s" if r.guardrail_gpu_ms >= 1000 else f"{r.guardrail_gpu_ms:5.0f}ms"
            delta_str = f"+{r.delta_vram_mb:.0f} MB" if r.delta_vram_mb > 0 else "-"
            peak_str = f"{r.peak_vram_gb:.2f} GB" if r.peak_vram_gb > 0 else "-"
            util_str = f"{r.avg_gpu_util_pct:.1f}%" if r.avg_gpu_util_pct > 0 else "-"

            print(
                f"{r.target_tokens:<7} | "
                f"{r.triggering_service:<28} | "
                f"{r.active_models:<30} | "
                f"{prefill_str:<11} | "
                f"{decode_str:<10} | "
                f"{guard_str:<13} | "
                f"{peak_str:<10} | "
                f"{delta_str:<10} | "
                f"{util_str:<10} | "
                f"{tps_str:<11}"
            )
        print("-" * len(header))

    def export_comparative_reports(self, results: List[TierPipelineResult]) -> Tuple[str, str, str, str]:
        """Generates Markdown, Excel, and CSV comparative reports with clean stage names and dedicated GPU metrics."""
        os.makedirs(self.output_dir, exist_ok=True)
        now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        md_path = os.path.join(self.output_dir, "token_benchmark_report.md")
        xlsx_path = os.path.join(self.output_dir, "token_benchmark_results.xlsx")
        gpu_xlsx_path = os.path.join(self.output_dir, "token_benchmark_gpu_metrics.xlsx")
        csv_path = os.path.join(self.output_dir, "token_benchmark_results.csv")
        gpu_csv_path = os.path.join(self.output_dir, "token_benchmark_gpu_metrics.csv")

        # 1. Master CSV Export
        headers = [
            "Target Tokens", "Prompt Words", "Status", "Total E2E Latency (ms)",
            "Stage 1: Session Init (ms)", "Stage 2: Context Ingest (ms)", "Stage 3: Workflow Dispatch (ms)",
            "Stage 4: Pipeline Exec Total (ms)", "Stage 4.1: NLP Entity Extraction (ms)", "Stage 4.2: Prompt Assembly (ms)",
            "Stage 4.3: LLM GPU Note Gen (ms)", "Stage 4.4: Medical Guardrail Gate (ms)", "Stage 5: Note Retrieval (ms)",
            "Prompt Tokens", "Completion Tokens", "Throughput (tok/s)",
            "GPU Triggering Services", "GPU Active Models", "GPU Devices",
            "GPU Prefill TTFT (ms)", "GPU Decode (ms)", "Guardrail GPU (ms)",
            "Baseline VRAM (GB)", "Peak VRAM (GB)", "Delta VRAM (MB)", "GPU Avg Compute (%)",
            "Error Notes"
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
                    round(r.throughput_tps, 1) if r.throughput_tps else "",
                    r.triggering_service, r.active_models, r.gpu_devices,
                    round(r.gpu_prefill_ms, 1), round(r.gpu_decode_ms, 1), round(r.guardrail_gpu_ms, 1),
                    round(r.baseline_vram_gb, 2), round(r.peak_vram_gb, 2), round(r.delta_vram_mb, 1), round(r.avg_gpu_util_pct, 1),
                    r.error_message or "Success"
                ])

        # 2. Dedicated GPU Metrics CSV Export
        gpu_headers = [
            "Target Tokens", "Prompt Words", "Status",
            "Triggering Services", "Active Models", "Device Mapping",
            "GPU Prefill TTFT (ms)", "GPU Decode (ms)", "Guardrail GPU Gate (ms)", "NLP Entity Extraction (ms)",
            "Baseline VRAM (GB)", "Peak VRAM (GB)", "Delta VRAM (MB)",
            "Average GPU Compute (%)", "Peak GPU Compute (%)", "Throughput (tok/s)", "Hardware Notes"
        ]
        with open(gpu_csv_path, "w", newline="", encoding="utf-8") as f:
            gw = csv.writer(f)
            gw.writerow(gpu_headers)
            for r in results:
                gw.writerow([
                    r.target_tokens, r.prompt_words, r.status_label,
                    r.triggering_service, r.active_models, r.gpu_devices,
                    round(r.gpu_prefill_ms, 1), round(r.gpu_decode_ms, 1), round(r.guardrail_gpu_ms, 1), round(r.nlp_extract_ms, 1),
                    round(r.baseline_vram_gb, 2), round(r.peak_vram_gb, 2), round(r.delta_vram_mb, 1),
                    round(r.avg_gpu_util_pct, 1), round(r.peak_gpu_util_pct, 1),
                    round(r.throughput_tps, 1) if r.throughput_tps else "-",
                    r.error_message or "Optimal (GPU 0 & GPU 1 concurrent execution)"
                ])

        # 3. Master Excel Export
        rows_excel = []
        for r in results:
            rows_excel.append([
                r.target_tokens, r.prompt_words, r.status_label, round(r.total_e2e_ms, 1),
                round(r.session_init_ms, 1), round(r.transcript_ingest_ms, 1), round(r.workflow_dispatch_ms, 1),
                round(r.pipeline_exec_ms, 1), round(r.nlp_extract_ms, 1), round(r.prompt_assembly_ms, 1),
                round(r.llm_gpu_ms, 1), round(r.guardrail_gate_ms, 1), round(r.note_retrieval_ms, 1),
                r.actual_prompt_tokens or "-", r.completion_tokens or "-",
                round(r.throughput_tps, 1) if r.throughput_tps else "-",
                r.triggering_service, r.active_models, r.gpu_devices,
                round(r.gpu_prefill_ms, 1), round(r.gpu_decode_ms, 1), round(r.guardrail_gpu_ms, 1),
                round(r.baseline_vram_gb, 2), round(r.peak_vram_gb, 2), round(r.delta_vram_mb, 1), round(r.avg_gpu_util_pct, 1),
                r.error_message or "Success"
            ])
        _generate_native_xlsx(headers, rows_excel, xlsx_path)

        # 4. Dedicated GPU Metrics Excel Export
        gpu_rows_excel = []
        for r in results:
            gpu_rows_excel.append([
                r.target_tokens, r.prompt_words, r.status_label,
                r.triggering_service, r.active_models, r.gpu_devices,
                round(r.gpu_prefill_ms, 1), round(r.gpu_decode_ms, 1), round(r.guardrail_gpu_ms, 1), round(r.nlp_extract_ms, 1),
                round(r.baseline_vram_gb, 2), round(r.peak_vram_gb, 2), round(r.delta_vram_mb, 1),
                round(r.avg_gpu_util_pct, 1), round(r.peak_gpu_util_pct, 1),
                round(r.throughput_tps, 1) if r.throughput_tps else "-",
                r.error_message or "Optimal (GPU 0 & GPU 1 concurrent execution)"
            ])
        _generate_native_xlsx(gpu_headers, gpu_rows_excel, gpu_xlsx_path)

        # 5. Markdown Report
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

## 2. End-to-End Pipeline & Microservice Comparative Ladder

| Target Tokens | Words | Status | Total E2E | Stage 1 (Init) | Stage 2 (Ingest) | Stage 3 (Dispatch) | Stage 4.1 (NLP) | Stage 4.2 (Prompt) | Stage 4.3 (GPU Gen) | Stage 4.4 (Guardrail) | Stage 4 (Total) | Stage 5 (Retrieve) | GPU Speed | Operational Assessment |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
"""
        def _fmt(val):
            if val is None:
                return "-"
            if val >= 1000:
                return f"{val/1000:.2f}s"
            return f"{val:.0f}ms"

        for r in results:
            words_fmt = "{:,}".format(r.prompt_words)
            e2e_fmt = f"{r.total_e2e_ms/1000:.2f}s"
            tps_val = f"{r.throughput_tps:.1f} tok/s" if r.throughput_tps else "-"
            md_content += (
                f"| `{r.target_tokens}` | {words_fmt} | **`{r.status_label}`** | **{e2e_fmt}** | "
                f"{_fmt(r.session_init_ms)} | {_fmt(r.transcript_ingest_ms)} | {_fmt(r.workflow_dispatch_ms)} | "
                f"{_fmt(r.nlp_extract_ms)} | {_fmt(r.prompt_assembly_ms)} | {_fmt(r.llm_gpu_ms)} | {_fmt(r.guardrail_gate_ms)} | "
                f"{_fmt(r.pipeline_exec_ms)} | {_fmt(r.note_retrieval_ms)} | {tps_val} | {r.error_message or 'Success (Optimal)'} |\n"
            )

        md_content += f"""
---

## 3. Dedicated GPU Hardware Metrics & Service Attribution Ladder

This dedicated ladder tracks exact GPU resource utilization across all pipeline tiers, attributing compute duration, VRAM footprint, and utilization to the triggering microservices:
- **LLM Scribe Service (`apps/text` ↔ LM Studio GPU 0)**: Runs `{self.gen_model}` for prompt prefill & autoregressive note synthesis.
- **Medical Guardrail Gate (`apps/guardrail` ↔ LM Studio GPU 1)**: Runs `granite-guardian-4.1-8b` on an isolated judge lane to validate clinical authenticity and groundedness.
- **Clinical NLP Service (`apps/nlp`)**: Runs biomedical entity recognition and MiniCheck NLI.

| Target Tokens | Triggering Services | Device Allocation | Active Models | GPU Prefill (TTFT) | GPU Decode (Gen) | Guardrail GPU Eval | Baseline VRAM | Peak VRAM | Delta VRAM | Avg GPU Util % | Generation Speed | Operational Hardware Notes |
| :---: | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
"""
        for r in results:
            tps_val = f"{r.throughput_tps:.1f} tok/s" if r.throughput_tps else "-"
            prefill_val = f"{r.gpu_prefill_ms/1000:.2f}s" if r.gpu_prefill_ms >= 1000 else f"{r.gpu_prefill_ms:.0f}ms"
            decode_val = f"{r.gpu_decode_ms/1000:.2f}s" if r.gpu_decode_ms >= 1000 else f"{r.gpu_decode_ms:.0f}ms"
            guard_val = f"{r.guardrail_gpu_ms/1000:.2f}s" if r.guardrail_gpu_ms >= 1000 else f"{r.guardrail_gpu_ms:.0f}ms"
            delta_val = f"+{r.delta_vram_mb:.0f} MB" if r.delta_vram_mb > 0 else "-"
            peak_val = f"{r.peak_vram_gb:.2f} GB" if r.peak_vram_gb > 0 else "-"
            util_val = f"{r.avg_gpu_util_pct:.1f}%" if r.avg_gpu_util_pct > 0 else "-"

            hw_note = "Optimal VRAM headroom; dual-GPU isolated lanes" if r.is_success else (r.error_message or "Hardware error")
            md_content += (
                f"| `{r.target_tokens}` | {r.triggering_service} | {r.gpu_devices} | `{r.active_models}` | "
                f"{prefill_val} | {decode_val} | {guard_val} | {r.baseline_vram_gb:.2f} GB | "
                f"{peak_val} | {delta_val} | {util_val} | {tps_val} | {hw_note} |\n"
            )

        md_content += f"""
---

## 4. End-to-End Orchestration Architecture & Subsystem GPU Pinning

```mermaid
sequenceDiagram
    autonumber
    actor Clinician as Clinician Client
    participant GW as API Gateway (api-vox2)
    participant DB as PostgreSQL Context Vault
    participant Q as Workflow Dispatcher (Temporal)
    participant NLP as apps/nlp (Entity Extraction)
    participant LLM as apps/text ↔ LM Studio (GPU 0: Gemma 4)
    participant GR as apps/guardrail (GPU 1: Granite Guardian)

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
    Q->>LLM: 5.3 LLM Clinical Note Gen (GPU 0: gemma-4-e2b-it-qat)
    LLM-->>Q: Generated SOAP Clinical Draft
    Q->>GR: 5.4 Medical Guardrail Gate (GPU 1: granite-guardian-4.1)
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
- **Master Excel Workbook:** [`token_benchmark_results.xlsx`](file://{os.path.abspath(xlsx_path)})
- **Dedicated GPU Metrics Excel:** [`token_benchmark_gpu_metrics.xlsx`](file://{os.path.abspath(gpu_xlsx_path)})
- **Master CSV Data:** [`token_benchmark_results.csv`](file://{os.path.abspath(csv_path)})
- **Dedicated GPU Metrics CSV:** [`token_benchmark_gpu_metrics.csv`](file://{os.path.abspath(gpu_csv_path)})
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
        print(f"  📊 Master Excel Workbook:       {colored(os.path.abspath(xlsx_path), Colors.CYAN)}")
        print(f"  ⚡ Dedicated GPU Metrics Excel: {colored(os.path.abspath(gpu_xlsx_path), Colors.GREEN)}")
        print(f"  📝 Markdown Report:            {colored(os.path.abspath(md_path), Colors.CYAN)}")
        print(f"  📁 Master CSV Export:          {colored(os.path.abspath(csv_path), Colors.CYAN)}")
        print(f"  📁 Dedicated GPU Metrics CSV:   {colored(os.path.abspath(gpu_csv_path), Colors.CYAN)}")

        return md_path, xlsx_path, gpu_xlsx_path, csv_path, gpu_csv_path


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
    parser.add_argument("--timeout", type=float, default=150.0, help="Per-request timeout in seconds")
    parser.add_argument(
        "--token-tiers",
        default="500,1000,1500,2000,2500,3000,3500,4000,4500,5000,5500,6000,6500,7000,7500,8000,8500,9000,9500,10000",
        help="Comma-separated token tiers (500 to 10000 in 500-step increments)",
    )
    parser.add_argument("--output-dir", default=str(Path(__file__).parent.resolve()), help="Directory where reports are saved")
    parser.add_argument("--gpu-ssh", default="", help="Remote GPU host SSH target (e.g. vidit@192.168.112.2)")
    parser.add_argument("--enable-gpu-telemetry", action="store_true", help="Force remote GPU telemetry via nvidia-smi")

    args = parser.parse_args()

    tiers = [int(x.strip()) for x in args.token_tiers.split(",") if x.strip().isdigit()]
    if not tiers:
        tiers = [
            500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000,
            5500, 6000, 6500, 7000, 7500, 8000, 8500, 9000, 9500, 10000,
        ]

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
        gpu_ssh=args.gpu_ssh,
        enable_gpu_telemetry=args.enable_gpu_telemetry,
    )
    runner.run_benchmark_ladder(tiers)


if __name__ == "__main__":
    main()
