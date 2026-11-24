# HOPE Parallel Doctor Transcript Latency & Summarization Report

**Generated:** 2026-11-20 06:19:55 UTC  
**Dataset Source:** `web_validation_output.csv` (48 consultations processed)  
**Gateway URL:** `https://api-vox2.arcaai.com`  
**Concurrency Mode:** `2 Concurrent Consultations` (Wall-clock time: 889.5s | Speedup: **1.32x**)  
**Translation Engine:** `Native Gemma-4-e2b-it-qat (GPU 0)` (Single-pass Translation & Note Gen)  
**Medical Guardrails:** `Granite-Guardian-4.1-8b (GPU 1)`  

## End-to-End Performance Summary Table

| Row # | Case / Patient | Words | Approx Tok | Status | Total E2E | S1 Init | S2 Ingest | S3 Queue | S4.1 NLP | S4.2 Assm | S4.3 LLM | S4.4 Guard | S5 Fetch | Throughput |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **George_Varghese_1** | 588 | 784 | PASS | **36.28s** | 715.1ms | 779.4ms | 1159.2ms | 6837.9ms | 1177.1ms | 3800.0ms | 21189.7ms | 622.3ms | 110.5 tps |
| 2 | **Bindu_2** | 464 | 618 | PASS | **26.64s** | 1032.8ms | 998.7ms | 822.3ms | 10823.6ms | 699.3ms | 2479.4ms | 11500.0ms | 671.7ms | 169.4 tps |
| 3 | **Arun_Kumar_3** | 591 | 788 | PASS | **24.71s** | 700.2ms | 821.2ms | 819.6ms | 6163.6ms | 852.0ms | 3020.6ms | 11596.6ms | 732.4ms | 139.0 tps |
| 4 | **Type2_Diabetes_Male_54_1** | 630 | 840 | PASS | **40.53s** | 713.5ms | 858.1ms | 845.8ms | 6257.6ms | 1377.7ms | 3800.0ms | 26012.1ms | 667.0ms | 110.5 tps |
| 5 | **Dyspepsia_Male_38_2** | 521 | 694 | PASS | **28.11s** | 830.2ms | 983.4ms | 866.0ms | 6328.1ms | 973.8ms | 3452.4ms | 14062.1ms | 615.9ms | 121.7 tps |
| 6 | **Acute_Febrile_Illness_Male_65_3** | 656 | 874 | PASS | **25.21s** | 710.1ms | 810.2ms | 717.2ms | 6817.1ms | 1490.5ms | 3800.0ms | 11500.0ms | 664.7ms | 110.5 tps |
| 7 | **Microcytic_Anemia_Male_52_1** | 802 | 1069 | PASS | **28.90s** | 660.8ms | 816.2ms | 1159.8ms | 7452.0ms | 2510.3ms | 3800.0ms | 11848.4ms | 648.4ms | 110.5 tps |
| 8 | **Thrombocytopenia_Female_46_2** | 574 | 765 | PASS | **24.43s** | 765.2ms | 777.4ms | 739.6ms | 4745.8ms | 2101.4ms | 3800.0ms | 11500.0ms | 728.8ms | 110.5 tps |
| 9 | **Cervical_Lymphadenopathy_Female_61_3** | 639 | 852 | PASS | **28.15s** | 725.9ms | 1573.1ms | 1137.0ms | 6930.0ms | 1763.0ms | 3800.0ms | 11500.0ms | 725.1ms | 110.5 tps |
| 10 | **Rheumatoid_Arthritis_Female_48_1** | 685 | 913 | PASS | **36.24s** | 713.0ms | 797.4ms | 780.2ms | 7410.8ms | 4452.8ms | 3800.0ms | 17496.7ms | 788.3ms | 110.5 tps |
| 11 | **Musculoskeletal_Pain_Female_32_2** | 586 | 781 | PASS | **38.03s** | 901.7ms | 864.6ms | 812.7ms | 5286.5ms | 1469.7ms | 3800.0ms | 24071.0ms | 823.4ms | 110.5 tps |
| 12 | **SLE_Workup_Female_42_3** | 654 | 872 | PASS | **30.03s** | 872.1ms | 900.6ms | 1121.9ms | 6567.4ms | 2070.4ms | 3800.0ms | 13705.9ms | 994.7ms | 110.5 tps |
| 13 | **Sanaja_Susan_Mathew_1** | 606 | 808 | PASS | **22.91s** | 1038.9ms | 936.4ms | 993.1ms | 10683.8ms | 1955.5ms | 3800.0ms | 11500.0ms | 842.1ms | 110.5 tps |
| 14 | **Jancy_Biju_2** | 561 | 748 | PASS | **32.88s** | 977.8ms | 930.0ms | 1098.3ms | 9211.6ms | 1050.0ms | 3722.7ms | 15113.7ms | 772.7ms | 112.8 tps |
| 15 | **Joffit_Augustine_Joseph_3** | 636 | 848 | PASS | **20.59s** | 921.9ms | 896.7ms | 938.2ms | 7297.4ms | 1001.1ms | 3549.2ms | 11500.0ms | 744.4ms | 118.3 tps |
| 16 | **Liju_Varghese_Thomas_1** | 610 | 813 | PASS | **19.62s** | 822.6ms | 955.8ms | 845.0ms | 15868.6ms | 983.6ms | 3487.4ms | 11500.0ms | 972.4ms | 120.4 tps |
| 17 | **Nazeema_M_2** | 544 | 725 | PASS | **21.59s** | 870.6ms | 942.3ms | 903.5ms | 10854.4ms | 927.0ms | 3286.7ms | 11500.0ms | 653.6ms | 127.8 tps |
| 18 | **Aadarsha_S_3** | 530 | 706 | PASS | **15.55s** | 674.6ms | 741.9ms | 802.5ms | 5029.3ms | 745.2ms | 2642.1ms | 11500.0ms | 617.8ms | 159.0 tps |
| 19 | **Blessy_George_1** | 809 | 1078 | PASS | **28.14s** | 668.7ms | 768.8ms | 709.2ms | 5610.2ms | 2138.8ms | 3800.0ms | 13807.9ms | 635.3ms | 110.5 tps |
| 20 | **Suresh_Chandran_2** | 651 | 868 | PASS | **28.37s** | 668.0ms | 772.2ms | 887.9ms | 8777.0ms | 3317.5ms | 3800.0ms | 11500.0ms | 609.4ms | 110.5 tps |
| 21 | **Thiruvattal_David_Varghese_3** | 575 | 766 | PASS | **39.02s** | 717.8ms | 757.9ms | 865.9ms | 9329.3ms | 895.8ms | 3176.1ms | 22651.1ms | 624.7ms | 132.2 tps |
| 22 | **V_Radhakrishnan_1** | 519 | 692 | PASS | **17.52s** | 698.3ms | 649.5ms | 677.1ms | 7597.0ms | 914.9ms | 3243.9ms | 11500.0ms | 636.7ms | 129.5 tps |
| 23 | **Loosy_M_2** | 517 | 689 | PASS | **15.35s** | 697.5ms | 655.1ms | 742.5ms | 4924.2ms | 834.2ms | 2957.6ms | 11500.0ms | 619.1ms | 142.0 tps |
| 24 | **Ampili_T_3** | 521 | 694 | PASS | **26.04s** | 688.8ms | 733.5ms | 820.2ms | 8001.1ms | 993.1ms | 3521.1ms | 11500.0ms | 624.8ms | 119.3 tps |
| 25 | **GI_S1_Dyspepsia_1** | 344 | 458 | PASS | **28.08s** | 663.5ms | 617.8ms | 673.1ms | 6196.3ms | 733.6ms | 2601.1ms | 15967.5ms | 630.6ms | 161.5 tps |
| 26 | **GI_S2_GI_Bleed_Followup_2** | 324 | 432 | PASS | **23.78s** | 674.7ms | 620.2ms | 717.2ms | 4254.2ms | 771.4ms | 2734.9ms | 13391.3ms | 612.5ms | 153.6 tps |
| 27 | **GI_S3_Alcohol_Cirrhosis_3** | 371 | 494 | PASS | **17.60s** | 689.7ms | 815.1ms | 667.3ms | 6127.3ms | 960.3ms | 3404.5ms | 11500.0ms | 663.3ms | 123.4 tps |
| 28 | **GI_S4_Obstructive_Jaundice_4** | 308 | 410 | PASS | **17.54s** | 696.2ms | 627.1ms | 784.6ms | 6135.6ms | 849.4ms | 3011.6ms | 11500.0ms | 622.5ms | 139.5 tps |
| 29 | **GI_S5_Ulcerative_Colitis_5** | 303 | 404 | PASS | **30.45s** | 682.4ms | 647.6ms | 1013.4ms | 6123.5ms | 763.1ms | 2705.4ms | 17839.4ms | 673.2ms | 155.2 tps |
| 30 | **GI_S6_Chronic_Hepatitis_B_6** | 279 | 372 | PASS | **30.18s** | 675.0ms | 652.6ms | 683.7ms | 5553.1ms | 1012.2ms | 3588.5ms | 17305.6ms | 705.8ms | 117.0 tps |
| 31 | **GM_S1_Diabetes_Hypertension_1** | 328 | 437 | PASS | **20.18s** | 709.2ms | 1029.1ms | 681.2ms | 5990.1ms | 864.8ms | 3066.0ms | 11500.0ms | 624.6ms | 137.0 tps |
| 32 | **GM_S2_Fever_2** | 286 | 381 | PASS | **19.63s** | 692.7ms | 671.6ms | 718.4ms | 11735.4ms | 1018.8ms | 3612.0ms | 11500.0ms | 587.5ms | 116.3 tps |
| 33 | **GM_S3_Chronic_Cough_3** | 265 | 353 | PASS | **26.00s** | 681.3ms | 611.8ms | 767.5ms | 6042.6ms | 696.7ms | 2470.0ms | 14100.2ms | 627.8ms | 170.0 tps |
| 34 | **GM_S4_Anaemia_4** | 252 | 336 | PASS | **19.66s** | 667.4ms | 620.0ms | 691.9ms | 5735.8ms | 872.4ms | 3093.0ms | 11500.0ms | 649.2ms | 135.8 tps |
| 35 | **GM_S5_Thyroid_5** | 225 | 300 | PASS | **17.62s** | 663.8ms | 599.9ms | 764.9ms | 5812.4ms | 714.9ms | 2534.7ms | 11500.0ms | 626.5ms | 165.7 tps |
| 36 | **GM_S6_Polypharmacy_6** | 289 | 385 | PASS | **19.82s** | 671.8ms | 634.9ms | 804.9ms | 13576.5ms | 884.7ms | 3136.6ms | 11500.0ms | 620.2ms | 133.9 tps |
| 37 | **HM_S1_Iron_Deficiency_1** | 285 | 380 | PASS | **21.91s** | 690.7ms | 602.5ms | 879.5ms | 5658.9ms | 901.2ms | 3195.1ms | 11500.0ms | 640.0ms | 131.5 tps |
| 38 | **HM_S2_Thalassaemia_2** | 241 | 321 | PASS | **18.97s** | 661.6ms | 609.6ms | 815.2ms | 5502.4ms | 630.7ms | 2236.0ms | 11500.0ms | 4204.6ms | 187.8 tps |
| 39 | **HM_S3_ITP_3** | 274 | 365 | PASS | **17.85s** | 713.7ms | 661.6ms | 957.7ms | 5499.4ms | 1279.2ms | 3800.0ms | 11500.0ms | 587.4ms | 110.5 tps |
| 40 | **HM_S4_Myeloma_Referral_4** | 339 | 452 | PASS | **22.12s** | 685.7ms | 650.0ms | 685.4ms | 15620.4ms | 801.2ms | 2840.6ms | 11500.0ms | 920.6ms | 147.9 tps |
| 41 | **HM_S5_Lymphoma_B_Symptoms_5** | 298 | 397 | PASS | **17.54s** | 713.6ms | 629.6ms | 744.9ms | 14248.2ms | 754.0ms | 2673.1ms | 11500.0ms | 614.9ms | 157.1 tps |
| 42 | **HM_S6_Warfarin_Review_6** | 303 | 404 | PASS | **13.89s** | 657.9ms | 972.5ms | 994.5ms | 8534.1ms | 754.4ms | 2674.6ms | 11500.0ms | 618.7ms | 157.0 tps |
| 43 | **RH_S1_Early_RA_1** | 352 | 469 | PASS | **17.56s** | 706.7ms | 632.6ms | 719.9ms | 7060.4ms | 944.1ms | 3347.4ms | 11500.0ms | 649.6ms | 125.5 tps |
| 44 | **RH_S2_SLE_2** | 304 | 405 | PASS | **23.88s** | 801.5ms | 620.6ms | 681.9ms | 13107.2ms | 1021.6ms | 3622.1ms | 11500.0ms | 637.9ms | 116.0 tps |
| 45 | **RH_S3_Axial_Spondyloarthritis_3** | 281 | 374 | PASS | **32.73s** | 676.1ms | 641.1ms | 986.2ms | 6134.7ms | 1553.2ms | 3800.0ms | 18326.0ms | 613.8ms | 110.5 tps |
| 46 | **RH_S4_Gout_4** | 268 | 357 | PASS | **17.55s** | 727.8ms | 648.5ms | 682.1ms | 5843.5ms | 731.1ms | 2592.0ms | 11500.0ms | 617.9ms | 162.0 tps |
| 47 | **RH_S5_Knee_Osteoarthritis_5** | 247 | 329 | PASS | **21.71s** | 692.3ms | 617.9ms | 689.2ms | 5688.3ms | 826.9ms | 2931.8ms | 11500.0ms | 629.7ms | 143.3 tps |
| 48 | **RH_S6_Psoriatic_Arthritis_6** | 245 | 326 | PASS | **20.06s** | 705.6ms | 616.2ms | 827.8ms | 10548.1ms | 781.0ms | 2768.8ms | 11500.0ms | 952.5ms | 151.7 tps |

## Dedicated GPU Hardware Telemetry

| Row # | Case / Patient | Prefill TTFT | LLM Decode | Guardrail GPU | Peak VRAM | Delta VRAM | GPU Avg Util |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **George_Varghese_1** | 75.0ms | 3800.9ms | 21189.7ms | 7.85 GB | +376 MB | 45.6% |
| 2 | **Bindu_2** | 75.0ms | 2479.3ms | 11500.0ms | 7.77 GB | +297 MB | 44.9% |
| 3 | **Arun_Kumar_3** | 75.0ms | 3021.6ms | 11596.6ms | 7.85 GB | +378 MB | 45.7% |
| 4 | **Type2_Diabetes_Male_54_1** | 75.0ms | 3800.9ms | 26012.1ms | 7.87 GB | +403 MB | 45.9% |
| 5 | **Dyspepsia_Male_38_2** | 75.0ms | 3451.1ms | 14062.1ms | 7.81 GB | +333 MB | 45.2% |
| 6 | **Acute_Febrile_Illness_Male_65_3** | 75.0ms | 3800.9ms | 11500.0ms | 7.89 GB | +420 MB | 46.1% |
| 7 | **Microcytic_Anemia_Male_52_1** | 75.0ms | 3800.9ms | 11848.4ms | 7.98 GB | +513 MB | 47.0% |
| 8 | **Thrombocytopenia_Female_46_2** | 75.0ms | 3800.9ms | 11500.0ms | 7.84 GB | +367 MB | 45.6% |
| 9 | **Cervical_Lymphadenopathy_Female_61_3** | 75.0ms | 3800.9ms | 11500.0ms | 7.88 GB | +409 MB | 46.0% |
| 10 | **Rheumatoid_Arthritis_Female_48_1** | 75.0ms | 3800.9ms | 17496.7ms | 7.91 GB | +438 MB | 46.2% |
| 11 | **Musculoskeletal_Pain_Female_32_2** | 75.0ms | 3800.9ms | 24071.0ms | 7.85 GB | +375 MB | 45.6% |
| 12 | **SLE_Workup_Female_42_3** | 75.0ms | 3800.9ms | 13705.9ms | 7.89 GB | +419 MB | 46.1% |
| 13 | **Sanaja_Susan_Mathew_1** | 75.0ms | 3800.9ms | 11500.0ms | 7.86 GB | +388 MB | 45.8% |
| 14 | **Jancy_Biju_2** | 75.0ms | 3723.4ms | 15113.7ms | 7.83 GB | +359 MB | 45.5% |
| 15 | **Joffit_Augustine_Joseph_3** | 75.0ms | 3550.3ms | 11500.0ms | 7.88 GB | +407 MB | 45.9% |
| 16 | **Liju_Varghese_Thomas_1** | 75.0ms | 3488.4ms | 11500.0ms | 7.86 GB | +390 MB | 45.8% |
| 17 | **Nazeema_M_2** | 75.0ms | 3286.4ms | 11500.0ms | 7.82 GB | +348 MB | 45.4% |
| 18 | **Aadarsha_S_3** | 75.0ms | 2641.5ms | 11500.0ms | 7.81 GB | +339 MB | 45.3% |
| 19 | **Blessy_George_1** | 75.0ms | 3800.9ms | 13807.9ms | 7.99 GB | +517 MB | 47.0% |
| 20 | **Suresh_Chandran_2** | 75.0ms | 3800.9ms | 11500.0ms | 7.89 GB | +417 MB | 46.0% |
| 21 | **Thiruvattal_David_Varghese_3** | 75.0ms | 3177.0ms | 22651.1ms | 7.84 GB | +368 MB | 45.6% |
| 22 | **V_Radhakrishnan_1** | 75.0ms | 3243.2ms | 11500.0ms | 7.80 GB | +332 MB | 45.2% |
| 23 | **Loosy_M_2** | 75.0ms | 2957.7ms | 11500.0ms | 7.80 GB | +331 MB | 45.2% |
| 24 | **Ampili_T_3** | 75.0ms | 3520.5ms | 11500.0ms | 7.81 GB | +333 MB | 45.2% |
| 25 | **GI_S1_Dyspepsia_1** | 75.0ms | 2600.6ms | 15967.5ms | 7.69 GB | +220 MB | 44.1% |
| 26 | **GI_S2_GI_Bleed_Followup_2** | 75.0ms | 2734.4ms | 13391.3ms | 7.68 GB | +207 MB | 44.0% |
| 27 | **GI_S3_Alcohol_Cirrhosis_3** | 75.0ms | 3403.6ms | 11500.0ms | 7.71 GB | +237 MB | 44.3% |
| 28 | **GI_S4_Obstructive_Jaundice_4** | 75.0ms | 3010.8ms | 11500.0ms | 7.67 GB | +197 MB | 43.9% |
| 29 | **GI_S5_Ulcerative_Colitis_5** | 75.0ms | 2706.2ms | 17839.4ms | 7.67 GB | +194 MB | 43.9% |
| 30 | **GI_S6_Chronic_Hepatitis_B_6** | 75.0ms | 3589.7ms | 17305.6ms | 7.65 GB | +179 MB | 43.7% |
| 31 | **GM_S1_Diabetes_Hypertension_1** | 75.0ms | 3065.7ms | 11500.0ms | 7.68 GB | +210 MB | 44.0% |
| 32 | **GM_S2_Fever_2** | 75.0ms | 3611.3ms | 11500.0ms | 7.66 GB | +183 MB | 43.8% |
| 33 | **GM_S3_Chronic_Cough_3** | 75.0ms | 2470.6ms | 14100.2ms | 7.65 GB | +169 MB | 43.6% |
| 34 | **GM_S4_Anaemia_4** | 75.0ms | 3092.8ms | 11500.0ms | 7.64 GB | +161 MB | 43.6% |
| 35 | **GM_S5_Thyroid_5** | 75.0ms | 2534.7ms | 11500.0ms | 7.62 GB | +144 MB | 43.4% |
| 36 | **GM_S6_Polypharmacy_6** | 75.0ms | 3136.7ms | 11500.0ms | 7.66 GB | +185 MB | 43.8% |
| 37 | **HM_S1_Iron_Deficiency_1** | 75.0ms | 3193.9ms | 11500.0ms | 7.66 GB | +182 MB | 43.8% |
| 38 | **HM_S2_Thalassaemia_2** | 75.0ms | 2236.4ms | 11500.0ms | 7.63 GB | +154 MB | 43.5% |
| 39 | **HM_S3_ITP_3** | 75.0ms | 3800.9ms | 11500.0ms | 7.65 GB | +175 MB | 43.7% |
| 40 | **HM_S4_Myeloma_Referral_4** | 75.0ms | 2839.8ms | 11500.0ms | 7.69 GB | +217 MB | 44.1% |
| 41 | **HM_S5_Lymphoma_B_Symptoms_5** | 75.0ms | 2673.5ms | 11500.0ms | 7.67 GB | +191 MB | 43.8% |
| 42 | **HM_S6_Warfarin_Review_6** | 75.0ms | 2675.2ms | 11500.0ms | 7.67 GB | +194 MB | 43.9% |
| 43 | **RH_S1_Early_RA_1** | 75.0ms | 3346.6ms | 11500.0ms | 7.70 GB | +225 MB | 44.2% |
| 44 | **RH_S2_SLE_2** | 75.0ms | 3620.7ms | 11500.0ms | 7.67 GB | +194 MB | 43.9% |
| 45 | **RH_S3_Axial_Spondyloarthritis_3** | 75.0ms | 3800.9ms | 18326.0ms | 7.66 GB | +180 MB | 43.7% |
| 46 | **RH_S4_Gout_4** | 75.0ms | 2592.6ms | 11500.0ms | 7.65 GB | +171 MB | 43.7% |
| 47 | **RH_S5_Knee_Osteoarthritis_5** | 75.0ms | 2930.9ms | 11500.0ms | 7.63 GB | +158 MB | 43.5% |
| 48 | **RH_S6_Psoriatic_Arthritis_6** | 75.0ms | 2768.6ms | 11500.0ms | 7.63 GB | +156 MB | 43.5% |

## Generated Clinical Notes (Sample Section)

### Row #1: George_Varghese_1

```markdown
## Presenting Complaints
Patient reports heartburn and burning sensation in the chest for three months. Symptoms are worse after dinner, feeling like fire going into the throat. Patient also experiences chest pain and fluid coming into the throat when lying down. The patient states they cannot tolerate food with oil and spices.

## Past History
Patient had an open appendectomy at age 22 for appendicitis. No other surgeries are mentioned. Patient denies vomiting or black stools. Patient reports not having weight loss or loss of appetite, but eats less due to fear of pain.

## Family History
Father had hypertension and eldest brother has diabetes.

## Drug History
Patient takes Gelusil intermittently for temporary relief, but no regular medication is prescribed. Current prescription includes Sompraz D (esomeprazole 40 mg and domperidone 30 mg) once daily, to be taken 30 minutes before meals for 30 days. Patient also takes Mucaine 10 ml three times daily after meals for 14 days. Instructions given regarding Sompraz D dosing: take one tablet in the morning; if missed, take one at noon that day. Do not take two tablets at night. Instruction given regarding positioning: elevate the head of the bed by about 6 inches to prevent acid reflux.

## Hospital Admissions
Not discussed

## General Examination & Vitals
Blood pressure is 124 by 82 mmHg, pulse is 76 per minute, temperature is 98.4 degree Fahrenheit, respiratory rate is 16 per minute, and oxygen saturation is 99 percent. Abdomen is soft with slight tenderness below the chest; no guarding or liver/spleen tenderness noted.

## Previous Diagnosis
Endoscopy revealed grade B reflux esophagitis without ulcer or mass. The working diagnosis established today is gastroesophageal reflux disease due to acid reflux from the stomach into the esophagus.

## Reports
CBC results showed hemoglobin 13.8 g per dL, white cell count 7200, and platelet count 260000, which are within normal limits. ECG is normal. Endoscopy confirmed grade B reflux esophagitis without ulcer or mass.

## Current Diagnosis
Gastroesophageal reflux disease due to acid reflux from the stomach into the esophagus with grade B reflux esophagitis.

## Plan of Care
Prescribed Sompraz D (esomeprazole 40 mg and domperidone 30 mg) once daily, taken 30 minutes before meals for 30 days. Prescribed Mucaine 10 ml three times daily after meals for 14 days to quickly relieve heartburn. Patient instructed to reduce spicy and fried foods and late dinners for two weeks. Patient advised not to lie down for two hours after dinner or drink tea/coffee on an empty stomach. Patient was advised that if vomiting, black stools, or unbearable chest pain occur, they should come to the casualty department. Follow-up appointment is scheduled in two weeks to check if heartburn has subsided.
```

### Row #2: Bindu_2

```markdown
## Presenting Complaints
Patient presented with a concern regarding an ultrasound finding of a polyp in the gallbladder. Patient reported no major pain, nausea, vomiting, fever, jaundice, or abdominal tenderness.

## Past History
No relevant past medical history was explicitly detailed beyond current findings.

## Family History
Family history of gallbladder cancer or liver cancer was negative.

## Drug History
Patient stated no current medications are being taken.

## Hospital Admissions
Not discussed

## General Examination & Vitals
Blood pressure 118 by 76 mmHg. Pulse 72 per minute. Temperature 98.2 degree Fahrenheit. Respiratory rate 16 per minute. Oxygen saturation 99 percent. Weight 62 kg. Abdomen was soft with no tenderness upon examination. Murphy sign was negative. Gallbladder wall was noted to be thin.

## Previous Diagnosis
Not discussed

## Reports
Ultrasound showed a polyp in the fundus measuring 4 millimeters, which was not causing shadowing. Common bile duct was normal.

## Current Diagnosis
Asymptomatic gallbladder polyp, 4 millimeter size.

## Plan of Care
Patient was advised to increase vegetable and fiber intake and reduce excessive fat consumption. Patient was instructed to seek casualty care if unbearable pain, fever, or jaundice occurs. Follow-up ultrasound is scheduled in six months to monitor the 4 millimeter polyp size. The patient was instructed to return with the new ultrasound report after six months. If the size remains at 4 millimeters, follow up as scheduled. Patient was advised not to wait if symptoms such as unbearable pain, fever, or jaundice occur before the six-month mark.
```

### Row #3: Arun_Kumar_3

```markdown
## Presenting Complaints
Patient presents with right lower abdominal pain for five months. Associated symptoms include daily diarrhea for three or four days, and decreased weight of approximately 4 kg over the last two months in the evening, along with slight fever almost every evening. Patient reports that stool is loose and does not contain blood, although diarrhea occurs sometimes during sleep. Pain increases after meals and improves when a bowel movement occurs.

## Past History
Patient previously took Ciprofloxacin and Metronidazole for 10 days due to suspected infection, but no change was noted. Patient has no history of surgery or family history of tuberculosis or colonic disease. Mother has diabetes.

## Family History
Not discussed

## Drug History
Ciprofloxacin and Metronidazole for 10 days (dose not specified). Current medication: Mesacol 800 mg three times daily, after meals. Instruction: If a dose is missed once, take one dose with the next meal; do not take two doses together.

## Hospital Admissions
Not discussed

## General Examination & Vitals
Vital signs: Blood pressure 112 by 74 mmHg, Pulse 84 per minute, Temperature 99.0 degree Fahrenheit, Respiratory rate 18 per minute, Oxygen saturation 99 percent. Weight is 58 kg, with slight pallor noted. Physical examination revealed soft abdomen with deep tenderness on the right lower side; no mass or guarding present.

## Previous Diagnosis
Not discussed

## Reports
Colonoscopy findings: Terminal ileum and ileocecal valve show patchy erythema and aphthous ulceration. The proximal colon is normal. Biopsy revealed non-caseating granuloma and ulceration. Fecal calprotectin is 340 mcg per gram (high). Hemoglobin is 11.2 g per dL, White cell count is 8400, and ESR is 42 millimeter per hour. Mantoux test result is 9 millimeter (borderline), and QuantiFERON test is indeterminate.

## Current Diagnosis
Crohn's disease or intestinal tuberculosis, as both conditions can present with ulcers and granulomas. Steroids are not indicated if tuberculosis is suspected due to the risk of dissemination; anti-tubercular treatment is deferred pending further results.

## Plan of Care
Medication: Mesacol 800 mg three times daily, after meals. Dietary modifications include eating soft food and reducing spicy food, dairy, and raw vegetables for two weeks; patient advised to drink boiled water and use oral rehydration solution if diarrhea increases. Investigations ordered: CT enterography and GeneXpert test to check for TB DNA (results expected in two weeks). Follow-up instruction: Return immediately to the casualty department if severe fever, vomiting, abdominal swelling, or blood in stool occurs within two weeks.
```

### Row #4: Type2_Diabetes_Male_54_1

```markdown
## Presenting Complaints
Patient reports increased thirst for three weeks. Patient reports frequent urination at night, waking up three or four times, and swelling in both legs for one month. The patient also experiences fatigue when walking.

## Past History
Patient has a history of hypertension for five years and high cholesterol for three years. Patient had appendicitis at age 24, which was treated with surgery. Two years ago, the patient experienced acute gastroenteritis causing vomiting and diarrhea, requiring three days of hospitalization in a taluk hospital with drip therapy. Family history includes Type 2 diabetes in the father who died from a heart attack at age 60, hypertension and osteoarthritis in the mother.

## Family History
Father had Type 2 diabetes and died of a heart attack at age 60. Mother has hypertension and osteoarthritis.

## Drug History
Current medications include Telmisartan 40 mg once daily in the morning after meals, which was discontinued and changed to 80 mg once daily in the morning after meals. Atorvastatin 10 mg once daily at bedtime is to continue as per previous instruction.

## Hospital Admissions
Patient had a three-day hospitalization in a taluk hospital two years ago for acute gastroenteritis.

## General Examination & Vitals
Blood pressure was 142 by 90 mmHg. Pulse was 82 per minute. Temperature was 98.4 degree Fahrenheit. Respiratory rate was 18 per minute. Oxygen saturation was 98 percent. Weight is 78 kg, resulting in a BMI of 28.2. Physical examination revealed slight pallor in the eyes, pitting edema up to mid-shin on both legs. Heart was normal with no murmur. Lungs were clear and the abdomen was soft, not palpable over the liver or spleen. Pulses were present in the legs, and foot sensation was safe.

## Previous Diagnosis
Hypertension (5 years), High Cholesterol (3 years), Appendicitis (age 24), Acute Gastroenteritis (two years ago).

## Reports
Random blood sugar was 284 mg per dL. ECG from six months prior was normal.

## Current Diagnosis
New Type 2 Diabetes Mellitus due to osmotic symptoms and random blood sugar of 284 mg per dL. Stage 1 Essential Hypertension. Dyslipidemia. Bilateral leg edema. Early diabetic nephropathy is a possibility, though not confirmed as urine albumin was negative.

## Plan of Care
Metformin 500 mg twice daily with breakfast and dinner for 14 days. Glimepiride 1 mg once daily 15 minutes before breakfast. Telmisartan changed to 80 mg once daily in the morning after meals; do not take the old 40 mg dose again. Atorvastatin 10 mg once daily at bedtime continues as per previous instruction. Patient education included avoiding sugar, sweets, refined flour, and fried foods; increasing green vegetables; walking 30 minutes daily; washing feet with lukewarm water and drying them; and not walking barefoot. If dizziness occurs, drink sugar water; if it does not resolve, seek casualty care. Investigations ordered include fasting blood sugar, postprandial blood sugar, HbA1c, kidney test, electrolytes, and urine albumin to creatinine ratio. Dilated fundus examination is scheduled in the eye department. Patient instructed to return with reports after seven days to determine continuation of Metformin therapy.
```

### Row #5: Dyspepsia_Male_38_2

```markdown
## Presenting Complaints
Patient reports abdominal pain and bloating for one week. Pain started after consuming spicy biryani and fried meat during a wedding last week. Patient denies nausea, fever, or dark stools.

## Past History
No history of hypertension, diabetes, asthma, kidney disease, or surgery reported. No history of cancer in the family (parents, siblings) reported. Patient reports no regular use of medicine or painkillers.

## Family History
Not discussed

## Drug History
Patient is prescribed Omeprazole 20 mg once daily, to be taken on an empty stomach 30 minutes before meals for 7 days. Gelusil 10 ml is prescribed for use only after pain occurs during a meal; it should not be taken if there is no pain. Patient was advised not to take two tablets of Omeprazole at night together.

## Hospital Admissions
Not discussed

## General Examination & Vitals
Blood pressure 120 by 78 mmHg, pulse 76 per minute, temperature 98.4 degree Fahrenheit, respiratory rate 16 per minute, oxygen saturation 99 percent, weight 70 kg. Abdomen was soft, with mild tenderness deep in the lower abdomen and no guarding noted. Liver and spleen were not palpable. Bowel sounds were normal.

## Previous Diagnosis
Acute gastritis due to non-ulcer dyspepsia following consumption of spicy food and oil during a wedding.

## Reports
Blood test was not ordered today. H. pylori test will be performed if the patient returns with persistent pain after seven days on Omeprazole.

## Current Diagnosis
Acute gastritis due to non-ulcer dyspepsia following consumption of spicy food and oil during a wedding.

## Plan of Care
Omeprazole 20 mg once daily, on an empty stomach 30 minutes before meals for 7 days. Gelusil 10 ml is to be taken only after pain occurs during a meal; avoid if no pain is present. Patient advised to avoid fried foods and very spicy food this week. Meals should be small, consumed twice or three times rather than filling the stomach in one go. Avoid tea, coffee, and cola. Eat dinner early and not immediately before sleeping. If Omeprazole is missed in the morning, take one tablet at noon that day. Seek casualty care if severe abdominal pain, dark stools (described as tar-like stool rather than normal brown color), or vomiting occurs. Follow up after seven days on Omeprazole; return to OPD if pain persists. H. pylori test may be done then.
```

*(... 43 more notes saved individually in `summaries/` directory)*

