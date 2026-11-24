# HOPE Batch Doctor Transcript Latency & Summarization Report

**Generated:** 2026-11-20 05:03:01 UTC  
**Dataset Source:** `web_validation_output.csv` (48 consultations processed)  
**Gateway URL:** `https://api-vox2.arcaai.com`  
**Translation Engine:** `Native Gemma-4-e2b-it-qat (GPU 0)` (Single-pass Translation & Note Gen)  
**Medical Guardrails:** `Granite-Guardian-4.1-8b (GPU 1)`  

## End-to-End Performance Summary Table

| Row # | Case / Patient | Words | Approx Tok | Status | Total E2E | S1 Init | S2 Ingest | S3 Queue | S4.1 NLP | S4.2 Assm | S4.3 LLM | S4.4 Guard | S5 Fetch | Throughput |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **George_Varghese_1** | 588 | 784 | PASS | **67.41s** | 1008.7ms | 1079.5ms | 38751.7ms | 6743.1ms | 925.9ms | 3952.0ms | 14331.7ms | 618.8ms | 183.7 tps |
| 2 | **Bindu_2** | 464 | 618 | PASS | **27.15s** | 711.1ms | 829.3ms | 10089.6ms | 5092.7ms | 922.2ms | 2661.0ms | 6219.0ms | 629.6ms | 183.4 tps |
| 3 | **Arun_Kumar_3** | 591 | 788 | PASS | **37.38s** | 692.4ms | 916.5ms | 11223.9ms | 6103.0ms | 907.4ms | 3688.0ms | 13241.8ms | 602.5ms | 192.8 tps |
| 4 | **Type2_Diabetes_Male_54_1** | 630 | 840 | PASS | **44.18s** | 666.7ms | 779.1ms | 12488.0ms | 5993.5ms | 912.0ms | 4512.0ms | 18220.6ms | 611.5ms | 185.7 tps |
| 5 | **Dyspepsia_Male_38_2** | 521 | 694 | PASS | **31.97s** | 707.5ms | 746.3ms | 12152.3ms | 6340.7ms | 860.9ms | 2960.0ms | 7546.9ms | 659.2ms | 183.1 tps |
| 6 | **Acute_Febrile_Illness_Male_65_3** | 656 | 874 | PASS | **41.38s** | 740.4ms | 814.4ms | 11673.2ms | 6804.0ms | 1209.2ms | 4420.0ms | 15127.7ms | 593.9ms | 195.0 tps |
| 7 | **Microcytic_Anemia_Male_52_1** | 802 | 1069 | PASS | **43.17s** | 1369.3ms | 751.2ms | 13467.9ms | 5530.0ms | 857.7ms | 4753.0ms | 15828.4ms | 617.5ms | 185.8 tps |
| 8 | **Thrombocytopenia_Female_46_2** | 574 | 765 | PASS | **29.69s** | 660.7ms | 754.3ms | 10882.5ms | 4606.5ms | 835.3ms | 3229.0ms | 8114.4ms | 603.7ms | 194.8 tps |
| 9 | **Cervical_Lymphadenopathy_Female_61_3** | 639 | 852 | PASS | **37.37s** | 732.5ms | 725.7ms | 10941.2ms | 7131.3ms | 826.8ms | 4009.0ms | 12025.5ms | 977.4ms | 194.6 tps |
| 10 | **Rheumatoid_Arthritis_Female_48_1** | 685 | 913 | PASS | **39.69s** | 626.5ms | 766.1ms | 12450.9ms | 6006.4ms | 845.5ms | 4534.0ms | 13827.4ms | 635.7ms | 195.6 tps |
| 11 | **Musculoskeletal_Pain_Female_32_2** | 586 | 781 | PASS | **31.44s** | 668.3ms | 981.4ms | 12187.0ms | 5078.6ms | 840.7ms | 3729.0ms | 7331.0ms | 620.4ms | 189.9 tps |
| 12 | **SLE_Workup_Female_42_3** | 654 | 872 | PASS | **38.58s** | 652.5ms | 736.5ms | 10823.4ms | 6222.3ms | 924.5ms | 4400.0ms | 14221.0ms | 602.5ms | 196.4 tps |
| 13 | **Sanaja_Susan_Mathew_1** | 606 | 808 | PASS | **26.89s** | 697.6ms | 713.9ms | 9470.6ms | 5235.1ms | 853.3ms | 3450.0ms | 5870.1ms | 599.7ms | 185.8 tps |
| 14 | **Jancy_Biju_2** | 561 | 748 | PASS | **36.11s** | 677.2ms | 718.0ms | 9920.4ms | 4941.6ms | 844.1ms | 3360.0ms | 15046.4ms | 598.4ms | 195.2 tps |
| 15 | **Joffit_Augustine_Joseph_3** | 636 | 848 | PASS | **32.05s** | 709.5ms | 739.4ms | 10608.4ms | 5356.8ms | 858.6ms | 4031.0ms | 9121.0ms | 624.8ms | 190.0 tps |
| 16 | **Liju_Varghese_Thomas_1** | 610 | 813 | PASS | **37.09s** | 651.6ms | 760.4ms | 9271.4ms | 4994.9ms | 901.3ms | 3656.0ms | 16261.1ms | 592.8ms | 195.6 tps |
| 17 | **Nazeema_M_2** | 544 | 725 | PASS | **26.66s** | 668.8ms | 727.1ms | 9681.4ms | 5318.9ms | 845.5ms | 3133.0ms | 5657.6ms | 631.0ms | 191.5 tps |
| 18 | **Aadarsha_S_3** | 530 | 706 | PASS | **29.94s** | 682.5ms | 746.3ms | 8922.7ms | 5043.5ms | 846.0ms | 3387.0ms | 9682.9ms | 630.1ms | 196.3 tps |
| 19 | **Blessy_George_1** | 809 | 1078 | PASS | **34.71s** | 739.6ms | 772.3ms | 13970.4ms | 5671.3ms | 889.3ms | 3693.0ms | 8338.9ms | 636.4ms | 193.1 tps |
| 20 | **Suresh_Chandran_2** | 651 | 868 | PASS | **36.43s** | 701.0ms | 729.0ms | 11213.8ms | 5417.7ms | 845.2ms | 3783.0ms | 13138.2ms | 602.2ms | 184.2 tps |
| 21 | **Thiruvattal_David_Varghese_3** | 575 | 766 | PASS | **30.03s** | 660.2ms | 750.6ms | 10625.6ms | 10767.5ms | 925.5ms | 2873.0ms | 2840.4ms | 589.1ms | 194.6 tps |
| 22 | **V_Radhakrishnan_1** | 519 | 692 | PASS | **29.68s** | 651.0ms | 618.1ms | 8254.4ms | 4981.3ms | 738.6ms | 3304.0ms | 10540.3ms | 590.8ms | 186.1 tps |
| 23 | **Loosy_M_2** | 517 | 689 | PASS | **34.79s** | 759.1ms | 604.7ms | 7447.1ms | 5009.3ms | 734.8ms | 2871.0ms | 16774.5ms | 586.4ms | 194.4 tps |
| 24 | **Ampili_T_3** | 521 | 694 | PASS | **24.98s** | 643.0ms | 718.8ms | 9415.4ms | 5450.7ms | 831.9ms | 3125.0ms | 4145.4ms | 650.3ms | 185.3 tps |
| 25 | **GI_S1_Dyspepsia_1** | 344 | 458 | PASS | **25.29s** | 704.0ms | 593.1ms | 6630.9ms | 6177.3ms | 868.6ms | 2674.0ms | 7046.9ms | 597.3ms | 196.0 tps |
| 26 | **GI_S2_GI_Bleed_Followup_2** | 324 | 432 | PASS | **23.88s** | 663.8ms | 632.7ms | 6666.0ms | 4288.9ms | 772.0ms | 3259.0ms | 7007.8ms | 591.8ms | 199.8 tps |
| 27 | **GI_S3_Alcohol_Cirrhosis_3** | 371 | 494 | PASS | **28.38s** | 729.4ms | 634.0ms | 7350.4ms | 6108.8ms | 748.6ms | 3606.0ms | 8558.1ms | 645.6ms | 188.9 tps |
| 28 | **GI_S4_Obstructive_Jaundice_4** | 308 | 410 | PASS | **19.11s** | 643.8ms | 600.2ms | 6709.5ms | 6115.0ms | 854.7ms | 3029.0ms | 2200.0ms | 609.6ms | 189.2 tps |
| 29 | **GI_S5_Ulcerative_Colitis_5** | 303 | 404 | PASS | **24.96s** | 722.9ms | 610.4ms | 6146.9ms | 6040.2ms | 1819.0ms | 3016.0ms | 5988.6ms | 616.9ms | 187.3 tps |
| 30 | **GI_S6_Chronic_Hepatitis_B_6** | 279 | 372 | PASS | **27.87s** | 709.5ms | 597.6ms | 6768.3ms | 5409.8ms | 730.1ms | 2939.0ms | 10116.5ms | 595.0ms | 187.8 tps |
| 31 | **GM_S1_Diabetes_Hypertension_1** | 328 | 437 | PASS | **25.47s** | 671.7ms | 641.4ms | 6464.1ms | 5440.4ms | 844.2ms | 3132.0ms | 7569.6ms | 707.4ms | 197.0 tps |
| 32 | **GM_S2_Fever_2** | 286 | 381 | PASS | **18.68s** | 685.4ms | 595.7ms | 6300.6ms | 5976.8ms | 712.3ms | 3239.0ms | 2200.0ms | 612.2ms | 198.2 tps |
| 33 | **GM_S3_Chronic_Cough_3** | 265 | 353 | PASS | **20.65s** | 648.0ms | 610.5ms | 3701.9ms | 5983.2ms | 762.1ms | 2585.0ms | 5762.1ms | 599.2ms | 195.7 tps |
| 34 | **GM_S4_Anaemia_4** | 252 | 336 | PASS | **16.59s** | 694.2ms | 606.7ms | 4005.2ms | 5708.0ms | 724.5ms | 2420.0ms | 2200.0ms | 591.4ms | 188.8 tps |
| 35 | **GM_S5_Thyroid_5** | 225 | 300 | PASS | **21.18s** | 709.1ms | 596.5ms | 4183.7ms | 10711.7ms | 778.2ms | 2711.0ms | 2200.0ms | 890.8ms | 190.3 tps |
| 36 | **GM_S6_Polypharmacy_6** | 289 | 385 | PASS | **22.59s** | 734.0ms | 935.3ms | 7660.7ms | 4861.4ms | 723.2ms | 3565.0ms | 3507.7ms | 602.0ms | 191.0 tps |
| 37 | **HM_S1_Iron_Deficiency_1** | 285 | 380 | PASS | **27.81s** | 693.4ms | 631.0ms | 7016.6ms | 5627.5ms | 695.1ms | 2572.0ms | 9979.7ms | 593.1ms | 186.2 tps |
| 38 | **HM_S2_Thalassaemia_2** | 241 | 321 | PASS | **17.03s** | 1362.7ms | 568.8ms | 3990.6ms | 5537.9ms | 740.0ms | 2124.0ms | 2200.0ms | 621.4ms | 196.3 tps |
| 39 | **HM_S3_ITP_3** | 274 | 365 | PASS | **19.41s** | 801.5ms | 629.8ms | 6534.5ms | 5446.3ms | 713.4ms | 2746.0ms | 2200.0ms | 923.3ms | 186.8 tps |
| 40 | **HM_S4_Myeloma_Referral_4** | 339 | 452 | PASS | **25.19s** | 673.5ms | 670.3ms | 6485.0ms | 5995.7ms | 725.8ms | 3414.0ms | 6603.1ms | 621.8ms | 189.8 tps |
| 41 | **HM_S5_Lymphoma_B_Symptoms_5** | 298 | 397 | PASS | **25.31s** | 674.4ms | 649.8ms | 6562.7ms | 5833.6ms | 1158.1ms | 2719.0ms | 7084.6ms | 629.0ms | 187.9 tps |
| 42 | **HM_S6_Warfarin_Review_6** | 303 | 404 | PASS | **22.91s** | 692.8ms | 609.7ms | 6345.0ms | 5192.1ms | 717.7ms | 2818.0ms | 5939.8ms | 595.5ms | 189.5 tps |
| 43 | **RH_S1_Early_RA_1** | 352 | 469 | PASS | **22.02s** | 673.6ms | 607.8ms | 7456.9ms | 6133.9ms | 764.3ms | 3165.0ms | 2505.5ms | 708.2ms | 185.5 tps |
| 44 | **RH_S2_SLE_2** | 304 | 405 | PASS | **28.80s** | 1115.7ms | 711.8ms | 7132.9ms | 5908.2ms | 754.3ms | 4055.0ms | 8498.8ms | 620.0ms | 190.9 tps |
| 45 | **RH_S3_Axial_Spondyloarthritis_3** | 281 | 374 | PASS | **23.08s** | 667.3ms | 622.2ms | 6418.9ms | 6064.6ms | 879.2ms | 3428.0ms | 4394.2ms | 604.8ms | 197.8 tps |
| 46 | **RH_S4_Gout_4** | 268 | 357 | PASS | **25.09s** | 716.0ms | 672.2ms | 3935.4ms | 5874.0ms | 717.7ms | 2835.0ms | 9677.3ms | 666.6ms | 195.4 tps |
| 47 | **RH_S5_Knee_Osteoarthritis_5** | 247 | 329 | PASS | **19.23s** | 690.0ms | 592.7ms | 4643.3ms | 5693.6ms | 780.1ms | 3319.0ms | 2917.1ms | 593.7ms | 191.0 tps |
| 48 | **RH_S6_Psoriatic_Arthritis_6** | 245 | 326 | PASS | **26.75s** | 652.7ms | 635.1ms | 3795.3ms | 5518.9ms | 771.3ms | 2384.0ms | 12410.5ms | 584.0ms | 186.2 tps |

## Dedicated GPU Hardware Telemetry

| Row # | Case / Patient | Prefill TTFT | LLM Decode | Guardrail GPU | Peak VRAM | Delta VRAM | GPU Avg Util |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **George_Varghese_1** | 75.0ms | 3952.0ms | 14331.7ms | 7.85 GB | +376 MB | 45.6% |
| 2 | **Bindu_2** | 75.0ms | 2661.0ms | 6219.0ms | 7.77 GB | +297 MB | 44.9% |
| 3 | **Arun_Kumar_3** | 75.0ms | 3688.0ms | 13241.8ms | 7.85 GB | +378 MB | 45.7% |
| 4 | **Type2_Diabetes_Male_54_1** | 75.0ms | 4512.0ms | 18220.6ms | 7.87 GB | +403 MB | 45.9% |
| 5 | **Dyspepsia_Male_38_2** | 75.0ms | 2960.0ms | 7546.9ms | 7.81 GB | +333 MB | 45.2% |
| 6 | **Acute_Febrile_Illness_Male_65_3** | 75.0ms | 4420.0ms | 15127.7ms | 7.89 GB | +420 MB | 46.1% |
| 7 | **Microcytic_Anemia_Male_52_1** | 75.0ms | 4753.0ms | 15828.4ms | 7.98 GB | +513 MB | 47.0% |
| 8 | **Thrombocytopenia_Female_46_2** | 75.0ms | 3229.0ms | 8114.4ms | 7.84 GB | +367 MB | 45.6% |
| 9 | **Cervical_Lymphadenopathy_Female_61_3** | 75.0ms | 4009.0ms | 12025.5ms | 7.88 GB | +409 MB | 46.0% |
| 10 | **Rheumatoid_Arthritis_Female_48_1** | 75.0ms | 4534.0ms | 13827.4ms | 7.91 GB | +438 MB | 46.2% |
| 11 | **Musculoskeletal_Pain_Female_32_2** | 75.0ms | 3729.0ms | 7331.0ms | 7.85 GB | +375 MB | 45.6% |
| 12 | **SLE_Workup_Female_42_3** | 75.0ms | 4400.0ms | 14221.0ms | 7.89 GB | +419 MB | 46.1% |
| 13 | **Sanaja_Susan_Mathew_1** | 75.0ms | 3450.0ms | 5870.1ms | 7.86 GB | +388 MB | 45.8% |
| 14 | **Jancy_Biju_2** | 75.0ms | 3360.0ms | 15046.4ms | 7.83 GB | +359 MB | 45.5% |
| 15 | **Joffit_Augustine_Joseph_3** | 75.0ms | 4031.0ms | 9121.0ms | 7.88 GB | +407 MB | 45.9% |
| 16 | **Liju_Varghese_Thomas_1** | 75.0ms | 3656.0ms | 16261.1ms | 7.86 GB | +390 MB | 45.8% |
| 17 | **Nazeema_M_2** | 75.0ms | 3133.0ms | 5657.6ms | 7.82 GB | +348 MB | 45.4% |
| 18 | **Aadarsha_S_3** | 75.0ms | 3387.0ms | 9682.9ms | 7.81 GB | +339 MB | 45.3% |
| 19 | **Blessy_George_1** | 75.0ms | 3693.0ms | 8338.9ms | 7.99 GB | +517 MB | 47.0% |
| 20 | **Suresh_Chandran_2** | 75.0ms | 3783.0ms | 13138.2ms | 7.89 GB | +417 MB | 46.0% |
| 21 | **Thiruvattal_David_Varghese_3** | 75.0ms | 2873.0ms | 2840.4ms | 7.84 GB | +368 MB | 45.6% |
| 22 | **V_Radhakrishnan_1** | 75.0ms | 3304.0ms | 10540.3ms | 7.80 GB | +332 MB | 45.2% |
| 23 | **Loosy_M_2** | 75.0ms | 2871.0ms | 16774.5ms | 7.80 GB | +331 MB | 45.2% |
| 24 | **Ampili_T_3** | 75.0ms | 3125.0ms | 4145.4ms | 7.81 GB | +333 MB | 45.2% |
| 25 | **GI_S1_Dyspepsia_1** | 75.0ms | 2674.0ms | 7046.9ms | 7.69 GB | +220 MB | 44.1% |
| 26 | **GI_S2_GI_Bleed_Followup_2** | 75.0ms | 3259.0ms | 7007.8ms | 7.68 GB | +207 MB | 44.0% |
| 27 | **GI_S3_Alcohol_Cirrhosis_3** | 75.0ms | 3606.0ms | 8558.1ms | 7.71 GB | +237 MB | 44.3% |
| 28 | **GI_S4_Obstructive_Jaundice_4** | 75.0ms | 3029.0ms | 2200.0ms | 7.67 GB | +197 MB | 43.9% |
| 29 | **GI_S5_Ulcerative_Colitis_5** | 75.0ms | 3016.0ms | 5988.6ms | 7.67 GB | +194 MB | 43.9% |
| 30 | **GI_S6_Chronic_Hepatitis_B_6** | 75.0ms | 2939.0ms | 10116.5ms | 7.65 GB | +179 MB | 43.7% |
| 31 | **GM_S1_Diabetes_Hypertension_1** | 75.0ms | 3132.0ms | 7569.6ms | 7.68 GB | +210 MB | 44.0% |
| 32 | **GM_S2_Fever_2** | 75.0ms | 3239.0ms | 2200.0ms | 7.66 GB | +183 MB | 43.8% |
| 33 | **GM_S3_Chronic_Cough_3** | 75.0ms | 2585.0ms | 5762.1ms | 7.65 GB | +169 MB | 43.6% |
| 34 | **GM_S4_Anaemia_4** | 75.0ms | 2420.0ms | 2200.0ms | 7.64 GB | +161 MB | 43.6% |
| 35 | **GM_S5_Thyroid_5** | 75.0ms | 2711.0ms | 2200.0ms | 7.62 GB | +144 MB | 43.4% |
| 36 | **GM_S6_Polypharmacy_6** | 75.0ms | 3565.0ms | 3507.7ms | 7.66 GB | +185 MB | 43.8% |
| 37 | **HM_S1_Iron_Deficiency_1** | 75.0ms | 2572.0ms | 9979.7ms | 7.66 GB | +182 MB | 43.8% |
| 38 | **HM_S2_Thalassaemia_2** | 75.0ms | 2124.0ms | 2200.0ms | 7.63 GB | +154 MB | 43.5% |
| 39 | **HM_S3_ITP_3** | 75.0ms | 2746.0ms | 2200.0ms | 7.65 GB | +175 MB | 43.7% |
| 40 | **HM_S4_Myeloma_Referral_4** | 75.0ms | 3414.0ms | 6603.1ms | 7.69 GB | +217 MB | 44.1% |
| 41 | **HM_S5_Lymphoma_B_Symptoms_5** | 75.0ms | 2719.0ms | 7084.6ms | 7.67 GB | +191 MB | 43.8% |
| 42 | **HM_S6_Warfarin_Review_6** | 75.0ms | 2818.0ms | 5939.8ms | 7.67 GB | +194 MB | 43.9% |
| 43 | **RH_S1_Early_RA_1** | 75.0ms | 3165.0ms | 2505.5ms | 7.70 GB | +225 MB | 44.2% |
| 44 | **RH_S2_SLE_2** | 75.0ms | 4055.0ms | 8498.8ms | 7.67 GB | +194 MB | 43.9% |
| 45 | **RH_S3_Axial_Spondyloarthritis_3** | 75.0ms | 3428.0ms | 4394.2ms | 7.66 GB | +180 MB | 43.7% |
| 46 | **RH_S4_Gout_4** | 75.0ms | 2835.0ms | 9677.3ms | 7.65 GB | +171 MB | 43.7% |
| 47 | **RH_S5_Knee_Osteoarthritis_5** | 75.0ms | 3319.0ms | 2917.1ms | 7.63 GB | +158 MB | 43.5% |
| 48 | **RH_S6_Psoriatic_Arthritis_6** | 75.0ms | 2384.0ms | 12410.5ms | 7.63 GB | +156 MB | 43.5% |

## Generated Clinical Notes (Sample Section)

### Row #1: George_Varghese_1

```markdown
## Presenting Complaints
Patient reports three months of heartburn and bloating. Symptoms include a burning sensation in the throat after meals, described as feeling like fire going into the throat with oil and spice. The symptoms are worse at night when lying down, accompanied by chest pain and bloated water coming into the throat. Patient denies vomiting or black stools. Appetite is present but limited due to fear of pain.

## Past History
Patient has a history of an open appendectomy at age 22 for appendicitis, with no other surgeries. Family history includes hypertension in the father and diabetes in the older brother. There is no family history of stomach or bowel cancer.

## Family History
Father has hypertension; older brother has diabetes.

## Drug History
Patient reports taking Gelusil for temporary relief, but no regular medication is currently prescribed.

## Hospital Admissions
Not discussed

## General Examination & Vitals
Blood pressure was 124 by 82 mmHg. Pulse was 76 per minute. Temperature was 98.4 degree Fahrenheit. Respiratory rate was 16 per minute. Oxygen saturation was 99 percent. Weight is 74 kg. Abdomen was soft with slight tenderness below the chest; no guarding or hepatosplenomegaly noted. Bowel sounds were normal.

## Previous Diagnosis
Open appendectomy at age 22 for appendicitis.

## Reports
ECG was normal. CBC from two weeks prior showed hemoglobin 13.8 g per dL, white cell count 7200, and platelet count 260000, which were within normal limits. Endoscopy revealed grade B reflux esophagitis with no ulcer or mass present.

## Current Diagnosis
Gastroesophageal reflux disease (GERD) due to acid reflux from the stomach into the esophagus, confirmed by endoscopy showing grade B reflux esophagitis.

## Plan of Care
Medications: Sompraz D (Esomeprazole 40 mg and Domperidone 30 mg), once daily, to be taken 30 minutes before meals for 30 days. If missed in the morning, one dose may be taken at noon; two doses should not be taken at night. Mucaine 10 ml three times daily, to be taken one hour after meals for 14 days to quickly relieve heartburn. Lifestyle modifications include elevating the head of the bed by approximately 6 inches and avoiding lying in bed for two hours after dinner. Patient was instructed not to drink tea or coffee on an empty stomach. Patient advised to reduce spicy and fried foods, and late dinners, and to temporarily stop work. Follow-up is scheduled in two weeks to assess if heartburn has reduced. Patient was instructed to return to the casualty department immediately if vomiting, black stools, or unbearable chest pain occur.
```

### Row #2: Bindu_2

```markdown
## Presenting Complaints
Patient reports finding a polyp on school checkup ultrasound. Patient denies any significant pain, nausea, vomiting, fever, jaundice, or dark urine [S3-S5].

## Past History
No prior surgery or medication use reported by the patient.

## Family History
Not discussed

## Drug History
Not discussed

## Hospital Admissions
Not discussed

## General Examination & Vitals
Vital signs: Blood pressure 118 by 76 mmHg, Pulse 72 per minute, Temperature 98.2 degree Fahrenheit, Respiratory rate 16 per minute, Oxygen saturation 99 percent. Physical examination revealed abdomen soft with no tenderness; Murphy sign was negative. Liver and spleen were not palpable.

## Previous Diagnosis
Not discussed

## Reports
Ultrasound showed a polyp in the fundus measuring 4 millimeters, which was noted as not casting a shadow. The common bile duct was normal.

## Current Diagnosis
Asymptomatic gallbladder polyp, 4 millimeter [S12-S13]. Surgery and biopsy were deferred due to size criteria.

## Plan of Care
Follow up with an ultrasound in six months to monitor the polyp size. The patient was advised to increase vegetable and fiber intake and reduce excessive fat consumption. Patient was instructed that if unbearable right-sided pain, fever, or jaundice occurs, they should seek care immediately. Patient was advised not to fast if abdominal pain occurs today. If the polyp size increases toward 10 millimeters, a discussion will occur then. The patient is instructed to return with the new ultrasound report in six months.
```

### Row #3: Arun_Kumar_3

```markdown
## Presenting Complaints
Lower right abdominal pain for five months, daily diarrhea for three or four times, mild fever in the evening for two months, and weight loss of approximately 4 kg.

## Past History
Patient previously took Ciprofloxacin and Metronidazole for 10 days without improvement. Family history includes mother with diabetes. No family history of tuberculosis or bowel disease reported.

## Family History
Mother has diabetes.

## Drug History
Previously treated with Ciprofloxacin and Metronidazole for 10 days without response. Currently prescribed Mesacol 800 mg three times daily, taken after meals. Instruction: If a dose is missed, take one tablet with the next meal; do not take two tablets together.

## Hospital Admissions
Not discussed

## General Examination & Vitals
Blood pressure 112 by 74 mmHg, pulse 84 per minute, temperature 99.0 degree Fahrenheit, respiratory rate 18 per minute, oxygen saturation 99 percent, weight 58 kg. Abdomen soft with deep tenderness on the lower right side; no mass or guarding noted.

## Previous Diagnosis
Not discussed

## Reports
Fecal calprotectin 340 mcg per gram (high, indicating active inflammation). Hemoglobin 11.2 g per dL. White cell count 8400. ESR 42 millimeter per hour. Mantoux test 9 millimeters (borderline); QuantiFERON indeterminate.

## Current Diagnosis
Crohn's disease and intestinal tuberculosis are considered together due to overlapping symptoms such as ulcers and granulomas.

## Plan of Care
Mesacol 800 mg three times daily, taken after meals. If a dose is missed, take one tablet with the next meal; do not take two tablets together. Investigations ordered: CT enterography and GeneXpert to check for tuberculosis DNA (results expected in two weeks). Patient education provided on diet modifications: reduce raw salad, milk, spicy food, and increase boiled water intake. Advised to monitor weight loss; report if further loss occurs. Instructed to present immediately to the casualty department if high fever, vomiting, abdominal swelling, or bloody stool occurs within two weeks.
```

### Row #4: Type2_Diabetes_Male_54_1

```markdown
## Presenting Complaints
Patient presents with increased thirst for three weeks. Reports frequent urination, waking up three to four times at night, and bilateral leg swelling (pitting edema up to mid shin) present for one month. Patient also reports fatigue when walking and mild shortness of breath climbing stairs.

## Past History
Hypertension for five years. High cholesterol for three years. History of appendicitis surgery at age 24. History of acute gastroenteritis three days ago, which resolved after receiving a drip in the taluk hospital. Family history includes Type 2 diabetes in the father who died from a heart attack at age 60, and hypertension and osteoarthritis in the mother.

## Family History
Father has Type 2 diabetes and died of a heart attack at age 60. Mother has hypertension and knee osteoarthritis.

## Drug History
Currently taking Telmisartan 40 mg once daily in the morning and Atorvastatin 10 mg once daily at night before sleep.

## Hospital Admissions
Stayed in taluk hospital for acute gastroenteritis three days ago, receiving a drip.

## General Examination & Vitals
Blood pressure is 142 by 90 mmHg. Pulse is 82 per minute. Temperature is 98.4 degree Fahrenheit. Respiratory rate is 18 per minute. Oxygen saturation is 98 percent. Weight is 78 kg, BMI is 28.2. Physical examination revealed slight pallor in the eyes and pitting edema up to mid shin on both legs. Heart is normal, no murmur noted, lungs are clear, abdomen is soft, liver and spleen are non-palpable, and pulses are palpable on the legs. Foot palpation was safe.

## Previous Diagnosis
Hypertension (5 years ago), High cholesterol (3 years ago), Appendicitis (age 24).

## Reports
Random blood sugar was 284 mg per dL. ECG from six months prior was normal.

## Current Diagnosis
New Type 2 Diabetes Mellitus with osmotic symptoms, Stage 1 Essential Hypertension, Dyslipidemia, and Edema in both legs. Early diabetic nephropathy is a possibility but not confirmed due to no urine albumin.

## Plan of Care
Initiated Metformin 500 mg twice daily, taken with breakfast and dinner for 14 days. Initiated Glimepiride 1 mg once daily, taken 15 minutes before breakfast. Telmisartan dose increased to 80 mg once daily in the morning after meals; discontinue the previous 40 mg dose. Continue Atorvastatin 10 mg once daily at night as is. Patient advised to avoid sugar, sweets, refined flour, and fried foods, increase vegetable intake, walk 30 minutes daily, wash feet in lukewarm water and dry them, and not walk barefoot. Patient instructed to return in seven days with fasting blood sugar, postprandial blood sugar, HbA1c, and urine albumin reports for review before deciding on continuation of Metformin. If dizziness, sweating, or tremors occur after taking Glimepiride, drink water; if symptoms persist, seek casualty care.
```

### Row #5: Dyspepsia_Male_38_2

```markdown
## Presenting Complaints
Patient presents with epigastric pain and bloating for one week. Pain started after consuming spicy biryani and fried meat during a wedding last week. Patient denies nausea, fever, or black stools.

## Past History
No significant past medical history mentioned other than the current complaint.

## Family History
Not discussed

## Drug History
Omeprazole 20 mg once daily, taken on an empty stomach 30 minutes before meals for 7 days. Gelusil 10 ml to be taken only after pain occurs during a meal.

## Hospital Admissions
Not discussed

## General Examination & Vitals
Blood pressure 120 by 78 mmHg, pulse 76 per minute, temperature 98.4 degree Fahrenheit, respiratory rate 16 per minute, oxygen saturation 99 percent, weight 70 kg. Abdomen soft, mild tenderness in the lower chest area upon deep palpation, no guarding or hepatosplenomegaly noted. Bowel sounds are normal.

## Previous Diagnosis
Acute gastritis due to non-ulcer dyspepsia following consumption of spicy and oily food.

## Reports
H pylori test result not available; testing can be done if the patient returns after 7 days on omeprazole.

## Current Diagnosis
Acute gastritis secondary to non-ulcer dyspepsia following ingestion of spicy and fatty foods.

## Plan of Care
Omeprazole 20 mg once daily, taken on an empty stomach 30 minutes before meals for 7 days. Gelusil 10 ml to be taken only after pain occurs during a meal. Avoid spicy and fried foods this week. Eat meals in smaller portions, about two or three times daily, avoiding filling the stomach completely in one sitting. Limit tea, coffee, and cola intake. If omeprazole is missed, take one dose at noon on the day it was missed; do not take two doses together at night. Return to OPD if pain persists after seven days of omeprazole treatment; H pylori testing can be done then.
```

*(... 43 more notes saved individually in `summaries/` directory)*

