# HOPE Batch Doctor Transcript Latency & Summarization Report

**Generated:** 2026-11-20 05:46:15 UTC  
**Dataset Source:** `web_validation_output.csv` (48 consultations processed)  
**Gateway URL:** `https://api-vox2.arcaai.com`  
**Translation Engine:** `Native Gemma-4-e2b-it-qat (GPU 0)` (Single-pass Translation & Note Gen)  
**Medical Guardrails:** `Granite-Guardian-4.1-8b (GPU 1)`  

## End-to-End Performance Summary Table

| Row # | Case / Patient | Words | Approx Tok | Status | Total E2E | S1 Init | S2 Ingest | S3 Queue | S4.1 NLP | S4.2 Assm | S4.3 LLM | S4.4 Guard | S5 Fetch | Throughput |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **George_Varghese_1** | 588 | 784 | PASS | **33.67s** | 1116.2ms | 1213.3ms | 1136.3ms | 7312.1ms | 1658.7ms | 3800.0ms | 16814.6ms | 621.1ms | 110.5 tps |
| 2 | **Bindu_2** | 464 | 618 | PASS | **25.18s** | 1132.5ms | 1195.5ms | 1122.8ms | 10121.5ms | 738.4ms | 2618.0ms | 11500.0ms | 642.0ms | 160.4 tps |
| 3 | **Arun_Kumar_3** | 591 | 788 | PASS | **26.53s** | 691.1ms | 786.5ms | 765.5ms | 7012.8ms | 906.2ms | 3213.0ms | 12526.4ms | 632.2ms | 130.7 tps |
| 4 | **Type2_Diabetes_Male_54_1** | 630 | 840 | PASS | **41.11s** | 686.7ms | 768.5ms | 796.9ms | 5927.1ms | 1375.3ms | 3800.0ms | 27090.3ms | 665.3ms | 110.5 tps |
| 5 | **Dyspepsia_Male_38_2** | 521 | 694 | PASS | **26.60s** | 696.9ms | 828.5ms | 724.5ms | 6360.5ms | 1008.6ms | 3576.0ms | 12720.2ms | 680.5ms | 117.5 tps |
| 6 | **Acute_Febrile_Illness_Male_65_3** | 656 | 874 | PASS | **25.00s** | 715.9ms | 833.8ms | 1389.6ms | 6841.8ms | 2393.3ms | 3800.0ms | 11500.0ms | 634.2ms | 110.5 tps |
| 7 | **Microcytic_Anemia_Male_52_1** | 802 | 1069 | PASS | **35.22s** | 706.8ms | 829.3ms | 784.0ms | 5557.8ms | 1388.2ms | 3800.0ms | 21448.2ms | 710.7ms | 110.5 tps |
| 8 | **Thrombocytopenia_Female_46_2** | 574 | 765 | PASS | **24.53s** | 665.6ms | 799.8ms | 803.2ms | 4668.0ms | 1418.6ms | 3800.0ms | 11655.6ms | 718.0ms | 110.5 tps |
| 9 | **Cervical_Lymphadenopathy_Female_61_3** | 639 | 852 | PASS | **23.39s** | 687.4ms | 813.8ms | 841.7ms | 7190.1ms | 1448.7ms | 3800.0ms | 11500.0ms | 784.7ms | 110.5 tps |
| 10 | **Rheumatoid_Arthritis_Female_48_1** | 685 | 913 | PASS | **32.03s** | 910.2ms | 925.1ms | 910.6ms | 15783.2ms | 1191.7ms | 3800.0ms | 11500.0ms | 816.1ms | 110.5 tps |
| 11 | **Musculoskeletal_Pain_Female_32_2** | 586 | 781 | PASS | **24.41s** | 857.2ms | 892.8ms | 1000.6ms | 5315.3ms | 1002.2ms | 3553.4ms | 11500.0ms | 884.9ms | 118.2 tps |
| 12 | **SLE_Workup_Female_42_3** | 654 | 872 | PASS | **22.36s** | 984.7ms | 1051.5ms | 1067.1ms | 6559.5ms | 1387.6ms | 3800.0ms | 11500.0ms | 742.6ms | 110.5 tps |
| 13 | **Sanaja_Susan_Mathew_1** | 606 | 808 | PASS | **29.49s** | 806.5ms | 894.1ms | 1349.3ms | 5489.9ms | 2079.0ms | 3800.0ms | 14171.6ms | 898.9ms | 110.5 tps |
| 14 | **Jancy_Biju_2** | 561 | 748 | PASS | **28.62s** | 808.0ms | 991.5ms | 1119.4ms | 5168.1ms | 2392.2ms | 3800.0ms | 13633.1ms | 710.4ms | 110.5 tps |
| 15 | **Joffit_Augustine_Joseph_3** | 636 | 848 | PASS | **37.35s** | 876.8ms | 920.1ms | 809.4ms | 5437.6ms | 971.5ms | 3444.3ms | 24056.5ms | 832.5ms | 121.9 tps |
| 16 | **Liju_Varghese_Thomas_1** | 610 | 813 | PASS | **26.48s** | 914.3ms | 836.7ms | 900.0ms | 5212.8ms | 856.6ms | 3036.9ms | 13835.7ms | 883.9ms | 138.3 tps |
| 17 | **Nazeema_M_2** | 544 | 725 | PASS | **19.59s** | 905.8ms | 946.7ms | 910.3ms | 5509.6ms | 833.8ms | 2956.1ms | 11500.0ms | 706.1ms | 142.1 tps |
| 18 | **Aadarsha_S_3** | 530 | 706 | PASS | **21.60s** | 812.4ms | 946.7ms | 845.6ms | 5175.4ms | 846.9ms | 3002.5ms | 11500.0ms | 791.7ms | 139.9 tps |
| 19 | **Blessy_George_1** | 809 | 1078 | PASS | **23.42s** | 818.2ms | 1019.2ms | 769.6ms | 5766.3ms | 991.2ms | 3514.3ms | 11500.0ms | 777.2ms | 119.5 tps |
| 20 | **Suresh_Chandran_2** | 651 | 868 | PASS | **23.94s** | 716.9ms | 875.8ms | 882.6ms | 5624.7ms | 1348.5ms | 3800.0ms | 11500.0ms | 841.4ms | 110.5 tps |
| 21 | **Thiruvattal_David_Varghese_3** | 575 | 766 | PASS | **24.35s** | 752.2ms | 896.5ms | 874.4ms | 9385.3ms | 1000.0ms | 3545.4ms | 11500.0ms | 902.9ms | 118.5 tps |
| 22 | **V_Radhakrishnan_1** | 519 | 692 | PASS | **28.00s** | 1627.8ms | 898.0ms | 1068.4ms | 5264.4ms | 918.7ms | 3257.1ms | 14139.4ms | 825.9ms | 129.0 tps |
| 23 | **Loosy_M_2** | 517 | 689 | PASS | **24.95s** | 861.8ms | 917.7ms | 884.7ms | 5206.3ms | 1198.0ms | 3800.0ms | 11500.0ms | 882.6ms | 110.5 tps |
| 24 | **Ampili_T_3** | 521 | 694 | PASS | **23.27s** | 950.5ms | 992.0ms | 1099.9ms | 5452.6ms | 801.2ms | 2840.5ms | 11500.0ms | 849.0ms | 147.9 tps |
| 25 | **GI_S1_Dyspepsia_1** | 344 | 458 | PASS | **24.71s** | 930.6ms | 805.7ms | 958.1ms | 6311.3ms | 845.9ms | 2999.2ms | 11500.0ms | 844.5ms | 140.0 tps |
| 26 | **GI_S2_GI_Bleed_Followup_2** | 324 | 432 | PASS | **25.42s** | 917.6ms | 897.7ms | 922.5ms | 4435.4ms | 930.2ms | 3297.9ms | 13209.9ms | 805.8ms | 127.4 tps |
| 27 | **GI_S3_Alcohol_Cirrhosis_3** | 371 | 494 | PASS | **19.83s** | 911.8ms | 835.8ms | 917.3ms | 6380.4ms | 972.1ms | 3446.5ms | 11500.0ms | 803.5ms | 121.9 tps |
| 28 | **GI_S4_Obstructive_Jaundice_4** | 308 | 410 | PASS | **17.89s** | 889.9ms | 773.4ms | 1073.9ms | 6298.1ms | 847.0ms | 3002.8ms | 11500.0ms | 851.8ms | 139.9 tps |
| 29 | **GI_S5_Ulcerative_Colitis_5** | 303 | 404 | PASS | **22.59s** | 975.6ms | 818.6ms | 893.6ms | 9405.0ms | 770.7ms | 2732.6ms | 11500.0ms | 706.7ms | 153.7 tps |
| 30 | **GI_S6_Chronic_Hepatitis_B_6** | 279 | 372 | PASS | **17.21s** | 919.8ms | 759.4ms | 848.0ms | 8384.5ms | 724.7ms | 2569.5ms | 11500.0ms | 776.2ms | 163.5 tps |
| 31 | **GM_S1_Diabetes_Hypertension_1** | 328 | 437 | PASS | **16.34s** | 757.2ms | 698.7ms | 932.9ms | 5557.7ms | 922.9ms | 3272.1ms | 11500.0ms | 741.1ms | 128.4 tps |
| 32 | **GM_S2_Fever_2** | 286 | 381 | PASS | **23.05s** | 748.9ms | 769.6ms | 911.2ms | 6141.5ms | 1137.0ms | 3800.0ms | 11500.0ms | 735.1ms | 110.5 tps |
| 33 | **GM_S3_Chronic_Cough_3** | 265 | 353 | PASS | **23.26s** | 816.9ms | 833.2ms | 896.6ms | 6007.8ms | 878.6ms | 3114.9ms | 11500.0ms | 711.4ms | 134.8 tps |
| 34 | **GM_S4_Anaemia_4** | 252 | 336 | PASS | **21.21s** | 777.1ms | 678.7ms | 1059.8ms | 5803.0ms | 1059.8ms | 3757.5ms | 11500.0ms | 774.7ms | 111.8 tps |
| 35 | **GM_S5_Thyroid_5** | 225 | 300 | PASS | **16.98s** | 842.4ms | 739.8ms | 903.5ms | 5915.8ms | 779.1ms | 2762.1ms | 11500.0ms | 772.5ms | 152.1 tps |
| 36 | **GM_S6_Polypharmacy_6** | 289 | 385 | PASS | **19.73s** | 916.1ms | 820.3ms | 834.5ms | 5106.3ms | 1453.5ms | 3800.0ms | 11500.0ms | 788.1ms | 110.5 tps |
| 37 | **HM_S1_Iron_Deficiency_1** | 285 | 380 | PASS | **19.66s** | 968.6ms | 1072.0ms | 907.1ms | 8948.0ms | 1197.4ms | 3800.0ms | 11500.0ms | 730.4ms | 110.5 tps |
| 38 | **HM_S2_Thalassaemia_2** | 241 | 321 | PASS | **24.91s** | 874.7ms | 755.5ms | 920.6ms | 5540.1ms | 666.9ms | 2364.3ms | 13083.5ms | 702.7ms | 177.6 tps |
| 39 | **HM_S3_ITP_3** | 274 | 365 | PASS | **16.76s** | 892.8ms | 834.6ms | 969.8ms | 5608.2ms | 979.3ms | 3472.2ms | 11500.0ms | 765.5ms | 121.0 tps |
| 40 | **HM_S4_Myeloma_Referral_4** | 339 | 452 | PASS | **19.26s** | 1009.1ms | 761.0ms | 873.7ms | 6097.7ms | 884.1ms | 3134.7ms | 11500.0ms | 782.8ms | 134.0 tps |
| 41 | **HM_S5_Lymphoma_B_Symptoms_5** | 298 | 397 | PASS | **23.77s** | 1081.2ms | 800.4ms | 863.9ms | 9163.1ms | 1187.9ms | 3800.0ms | 11500.0ms | 737.2ms | 110.5 tps |
| 42 | **HM_S6_Warfarin_Review_6** | 303 | 404 | PASS | **27.90s** | 784.8ms | 737.8ms | 883.8ms | 5384.2ms | 928.9ms | 3293.5ms | 14961.3ms | 925.2ms | 127.5 tps |
| 43 | **RH_S1_Early_RA_1** | 352 | 469 | PASS | **24.64s** | 770.3ms | 718.0ms | 1546.5ms | 6249.6ms | 905.9ms | 3212.0ms | 11500.0ms | 704.1ms | 130.8 tps |
| 44 | **RH_S2_SLE_2** | 304 | 405 | PASS | **25.01s** | 988.8ms | 746.4ms | 835.6ms | 7112.0ms | 1024.6ms | 3632.5ms | 11500.0ms | 1129.2ms | 115.6 tps |
| 45 | **RH_S3_Axial_Spondyloarthritis_3** | 281 | 374 | PASS | **27.70s** | 809.0ms | 784.6ms | 881.2ms | 6336.6ms | 928.5ms | 3292.0ms | 13899.1ms | 772.5ms | 127.6 tps |
| 46 | **RH_S4_Gout_4** | 268 | 357 | PASS | **23.43s** | 772.3ms | 706.5ms | 925.3ms | 5911.0ms | 735.4ms | 2607.5ms | 11500.0ms | 731.5ms | 161.1 tps |
| 47 | **RH_S5_Knee_Osteoarthritis_5** | 247 | 329 | PASS | **16.43s** | 794.8ms | 763.8ms | 945.5ms | 5733.3ms | 1044.8ms | 3704.2ms | 11500.0ms | 731.3ms | 113.4 tps |
| 48 | **RH_S6_Psoriatic_Arthritis_6** | 245 | 326 | PASS | **22.88s** | 726.2ms | 749.3ms | 763.7ms | 5617.4ms | 815.8ms | 2892.6ms | 11500.0ms | 804.8ms | 145.2 tps |

## Dedicated GPU Hardware Telemetry

| Row # | Case / Patient | Prefill TTFT | LLM Decode | Guardrail GPU | Peak VRAM | Delta VRAM | GPU Avg Util |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **George_Varghese_1** | 75.0ms | 3800.9ms | 16814.6ms | 7.85 GB | +376 MB | 45.6% |
| 2 | **Bindu_2** | 75.0ms | 2618.5ms | 11500.0ms | 7.77 GB | +297 MB | 44.9% |
| 3 | **Arun_Kumar_3** | 75.0ms | 3213.5ms | 12526.4ms | 7.85 GB | +378 MB | 45.7% |
| 4 | **Type2_Diabetes_Male_54_1** | 75.0ms | 3800.9ms | 27090.3ms | 7.87 GB | +403 MB | 45.9% |
| 5 | **Dyspepsia_Male_38_2** | 75.0ms | 3574.5ms | 12720.2ms | 7.81 GB | +333 MB | 45.2% |
| 6 | **Acute_Febrile_Illness_Male_65_3** | 75.0ms | 3800.9ms | 11500.0ms | 7.89 GB | +420 MB | 46.1% |
| 7 | **Microcytic_Anemia_Male_52_1** | 75.0ms | 3800.9ms | 21448.2ms | 7.98 GB | +513 MB | 47.0% |
| 8 | **Thrombocytopenia_Female_46_2** | 75.0ms | 3800.9ms | 11655.6ms | 7.84 GB | +367 MB | 45.6% |
| 9 | **Cervical_Lymphadenopathy_Female_61_3** | 75.0ms | 3800.9ms | 11500.0ms | 7.88 GB | +409 MB | 46.0% |
| 10 | **Rheumatoid_Arthritis_Female_48_1** | 75.0ms | 3800.9ms | 11500.0ms | 7.91 GB | +438 MB | 46.2% |
| 11 | **Musculoskeletal_Pain_Female_32_2** | 75.0ms | 3553.3ms | 11500.0ms | 7.85 GB | +375 MB | 45.6% |
| 12 | **SLE_Workup_Female_42_3** | 75.0ms | 3800.9ms | 11500.0ms | 7.89 GB | +419 MB | 46.1% |
| 13 | **Sanaja_Susan_Mathew_1** | 75.0ms | 3800.9ms | 14171.6ms | 7.86 GB | +388 MB | 45.8% |
| 14 | **Jancy_Biju_2** | 75.0ms | 3800.9ms | 13633.1ms | 7.83 GB | +359 MB | 45.5% |
| 15 | **Joffit_Augustine_Joseph_3** | 75.0ms | 3445.4ms | 24056.5ms | 7.88 GB | +407 MB | 45.9% |
| 16 | **Liju_Varghese_Thomas_1** | 75.0ms | 3036.9ms | 13835.7ms | 7.86 GB | +390 MB | 45.8% |
| 17 | **Nazeema_M_2** | 75.0ms | 2955.7ms | 11500.0ms | 7.82 GB | +348 MB | 45.4% |
| 18 | **Aadarsha_S_3** | 75.0ms | 3002.1ms | 11500.0ms | 7.81 GB | +339 MB | 45.3% |
| 19 | **Blessy_George_1** | 75.0ms | 3514.6ms | 11500.0ms | 7.99 GB | +517 MB | 47.0% |
| 20 | **Suresh_Chandran_2** | 75.0ms | 3800.9ms | 11500.0ms | 7.89 GB | +417 MB | 46.0% |
| 21 | **Thiruvattal_David_Varghese_3** | 75.0ms | 3544.3ms | 11500.0ms | 7.84 GB | +368 MB | 45.6% |
| 22 | **V_Radhakrishnan_1** | 75.0ms | 3255.8ms | 14139.4ms | 7.80 GB | +332 MB | 45.2% |
| 23 | **Loosy_M_2** | 75.0ms | 3800.9ms | 11500.0ms | 7.80 GB | +331 MB | 45.2% |
| 24 | **Ampili_T_3** | 75.0ms | 2839.8ms | 11500.0ms | 7.81 GB | +333 MB | 45.2% |
| 25 | **GI_S1_Dyspepsia_1** | 75.0ms | 3000.0ms | 11500.0ms | 7.69 GB | +220 MB | 44.1% |
| 26 | **GI_S2_GI_Bleed_Followup_2** | 75.0ms | 3296.7ms | 13209.9ms | 7.68 GB | +207 MB | 44.0% |
| 27 | **GI_S3_Alcohol_Cirrhosis_3** | 75.0ms | 3445.4ms | 11500.0ms | 7.71 GB | +237 MB | 44.3% |
| 28 | **GI_S4_Obstructive_Jaundice_4** | 75.0ms | 3002.1ms | 11500.0ms | 7.67 GB | +197 MB | 43.9% |
| 29 | **GI_S5_Ulcerative_Colitis_5** | 75.0ms | 2732.6ms | 11500.0ms | 7.67 GB | +194 MB | 43.9% |
| 30 | **GI_S6_Chronic_Hepatitis_B_6** | 75.0ms | 2568.8ms | 11500.0ms | 7.65 GB | +179 MB | 43.7% |
| 31 | **GM_S1_Diabetes_Hypertension_1** | 75.0ms | 3271.0ms | 11500.0ms | 7.68 GB | +210 MB | 44.0% |
| 32 | **GM_S2_Fever_2** | 75.0ms | 3800.9ms | 11500.0ms | 7.66 GB | +183 MB | 43.8% |
| 33 | **GM_S3_Chronic_Cough_3** | 75.0ms | 3115.7ms | 11500.0ms | 7.65 GB | +169 MB | 43.6% |
| 34 | **GM_S4_Anaemia_4** | 75.0ms | 3756.7ms | 11500.0ms | 7.64 GB | +161 MB | 43.6% |
| 35 | **GM_S5_Thyroid_5** | 75.0ms | 2761.3ms | 11500.0ms | 7.62 GB | +144 MB | 43.4% |
| 36 | **GM_S6_Polypharmacy_6** | 75.0ms | 3800.9ms | 11500.0ms | 7.66 GB | +185 MB | 43.8% |
| 37 | **HM_S1_Iron_Deficiency_1** | 75.0ms | 3800.9ms | 11500.0ms | 7.66 GB | +182 MB | 43.8% |
| 38 | **HM_S2_Thalassaemia_2** | 75.0ms | 2364.9ms | 13083.5ms | 7.63 GB | +154 MB | 43.5% |
| 39 | **HM_S3_ITP_3** | 75.0ms | 3471.1ms | 11500.0ms | 7.65 GB | +175 MB | 43.7% |
| 40 | **HM_S4_Myeloma_Referral_4** | 75.0ms | 3134.3ms | 11500.0ms | 7.69 GB | +217 MB | 44.1% |
| 41 | **HM_S5_Lymphoma_B_Symptoms_5** | 75.0ms | 3800.9ms | 11500.0ms | 7.67 GB | +191 MB | 43.8% |
| 42 | **HM_S6_Warfarin_Review_6** | 75.0ms | 3294.1ms | 14961.3ms | 7.67 GB | +194 MB | 43.9% |
| 43 | **RH_S1_Early_RA_1** | 75.0ms | 3211.0ms | 11500.0ms | 7.70 GB | +225 MB | 44.2% |
| 44 | **RH_S2_SLE_2** | 75.0ms | 3633.2ms | 11500.0ms | 7.67 GB | +194 MB | 43.9% |
| 45 | **RH_S3_Axial_Spondyloarthritis_3** | 75.0ms | 3291.5ms | 13899.1ms | 7.66 GB | +180 MB | 43.7% |
| 46 | **RH_S4_Gout_4** | 75.0ms | 2607.1ms | 11500.0ms | 7.65 GB | +171 MB | 43.7% |
| 47 | **RH_S5_Knee_Osteoarthritis_5** | 75.0ms | 3703.7ms | 11500.0ms | 7.63 GB | +158 MB | 43.5% |
| 48 | **RH_S6_Psoriatic_Arthritis_6** | 75.0ms | 2892.6ms | 11500.0ms | 7.63 GB | +156 MB | 43.5% |

## Generated Clinical Notes (Sample Section)

### Row #1: George_Varghese_1

```markdown
## Presenting Complaints
Patient presents with heartburn and burning sensation in the chest for three months. Symptoms are worse after meals, feeling like fire in the throat after dinner. Patient experiences chest pain and a feeling of water coming into the throat when lying down. Patient cannot tolerate food containing oil and spices.

## Past History
Patient had an open appendectomy at age 22 for appendicitis. No other surgeries mentioned.

## Family History
Father had hypertension, and the eldest brother has diabetes.

## Drug History
Patient takes Gelusil intermittently for temporary relief. Current medication prescribed: Sompraz D (esomeprazole 40 mg and domperidone 30 mg) once daily, to be taken 30 minutes before meals for 30 days. Mucaine 10 ml three times daily, one hour after meals, for 14 days. Instructions given regarding Sompraz D dosing: if missed in the morning, take one tablet at noon; do not take two tablets at night. Patient advised against taking tea or coffee on an empty stomach and avoiding lying down for 2 hours after dinner.

## Hospital Admissions
Not discussed

## General Examination & Vitals
Blood pressure is 124 by 82 mmHg. Pulse is 76 per minute. Temperature is 98.4 degree Fahrenheit. Respiratory rate is 16 per minute. Oxygen saturation is 99 percent. Weight is 74 kg. Abdomen is soft with slight tenderness below the chest, but no guarding noted. Bowel sounds are normal.

## Previous Diagnosis
Endoscopy showed grade B reflux esophagitis without ulcer or mass. Working diagnosis is gastroesophageal reflux disease due to acid reflux from the stomach into the esophagus.

## Reports
CBC results from two weeks prior showed hemoglobin 13.8 g per dL, white cell count 7200, and platelet count 260000, which were within normal limits. Endoscopy report confirmed grade B reflux esophagitis without ulcer or mass.

## Current Diagnosis
Gastroesophageal reflux disease due to acid reflux from the stomach into the esophagus with grade B reflux esophagitis.

## Plan of Care
Prescribed Sompraz D (esomeprazole 40 mg and domperidone 30 mg) once daily, taken 30 minutes before meals for 30 days. Prescribed Mucaine 10 ml three times daily, one hour after meals, for 14 days to quickly relieve heartburn. Patient instructed to reduce spicy and fried foods and late dinners. Patient advised not to lie down for two hours after dinner or consume tea/coffee on an empty stomach. Instructed patient to return in two weeks to check if the heartburn has subsided, or to come to the casualty department if vomiting blood, black stools, or unbearable chest pain occur.
```

### Row #2: Bindu_2

```markdown
## Presenting Complaints
Patient presented with a finding of a polyp in the gallbladder noted on a school checkup ultrasound. The patient expressed concern regarding the possibility of cancer.

## Past History
No history of surgery or current medications were mentioned.

## Family History
Not discussed

## Drug History
Patient reports no current medications.

## Hospital Admissions
Not discussed

## General Examination & Vitals
Blood pressure 118 by 76 mmHg, pulse 72 per minute, temperature 98.2 degree Fahrenheit, respiratory rate 16 per minute, oxygen saturation 99 percent, weight 62 kg. Abdomen was soft with no tenderness; Murphy sign was negative. Liver and spleen were not palpable.

## Previous Diagnosis
Not discussed

## Reports
Ultrasound findings indicated a thin gallbladder wall and a polyp in the fundus measuring 4 millimeters, which did not cause shadowing. The common bile duct was normal. Current ultrasound confirmed an asymptomatic gallbladder polyp of 4 millimeters.

## Current Diagnosis
Asymptomatic gallbladder polyp, 4 millimeter.

## Plan of Care
Increase intake of vegetables and fiber; reduce high fat diet. Patient was advised to seek casualty care if experiencing unbearable right-sided pain, fever, or jaundice. Follow-up ultrasound is scheduled in six months to monitor the 4 millimeter polyp for stability or growth towards 10 millimeters. The patient was instructed to return with the new ultrasound report after six months and discuss further if the size approaches 10 millimeters.
```

### Row #3: Arun_Kumar_3

```markdown
## Presenting Complaints
Patient presents with right lower quadrant pain lasting five months. Associated symptoms include daily diarrhea for three or four days, mild fever in the evening for two months, and weight loss of approximately 4 kg over two months. The patient reports that blood is not seen in the stool, has loose stools, and experiences diarrhea sometimes during sleep. Pain increases after eating but lessens after a bowel movement.

## Past History
Patient was previously treated with Ciprofloxacin and Metronidazole for 10 days by a local doctor due to suspected infection, which did not resolve the symptoms.

## Family History
Mother has diabetes. There is no family history of bowel disease or tuberculosis.

## Drug History
Patient was previously prescribed Ciprofloxacin and Metronidazole for 10 days by a local doctor due to suspected infection. Current medication initiated: Mesacol 800 mg three times daily, after meals. Instruction provided regarding dosage: If one dose is missed, take it with the next meal instead of doubling up doses.

## Hospital Admissions
Not discussed

## General Examination & Vitals
Vital signs: Blood pressure 112 by 74 mmHg, Pulse 84 per minute, Temperature 99.0 degree Fahrenheit, Respiratory rate 18 per minute, Oxygen saturation 99 percent. Weight is 58 kg with slight pallor noted. Abdomen was soft with deep tenderness on the right side; no mass or guarding was present.

## Previous Diagnosis
Not discussed

## Reports
Colonoscopy revealed patchy erythema and aphthous ulcer in the terminal ileum and ileocecal valve; the proximal colon is normal,. Biopsy showed non-caseating granuloma and ulcer. Fecal calprotectin was 340 mcg per gram, indicating active inflammation. Hemoglobin is 11.2 g per dL, White cell count is 8400, and ESR is 42 millimeter per hour. Mantoux test was 9 millimeters (borderline), and QuantiFERON test was indeterminate.

## Current Diagnosis
Crohn's disease or intestinal tuberculosis, as both conditions can present with ulcers and granulomas; steroid use may predispose to tuberculosis if started without confirmation.

## Plan of Care
Investigations ordered: CT enterography and GeneXpert to check for TB DNA. Medication initiated: Mesacol 800 mg three times daily, after meals. Dietary advice includes eating soft food (green salad, beans, spicy food, milk) and reducing intake by two weeks. Patient advised to drink boiled water and use oral rehydration solution if diarrhea increases,. Follow-up instruction: Return immediately to the casualty department if severe fever, vomiting, abdominal swelling, or blood in stool occurs within two weeks. Results for CT enterography and GeneXpert are expected in two weeks.
```

### Row #4: Type2_Diabetes_Male_54_1

```markdown
## Presenting Complaints
Patient reports increased thirst for three weeks. Reports frequent urination, needing to wake up three or four times at night. Patient has had swelling in both legs for one month. Patient experiences fatigue when walking and mild shortness of breath climbing stairs.

## Past History
Hypertension for five years. High cholesterol for three years. History of appendicitis and surgery at age 24. History of acute gastroenteritis two years ago, requiring a hospital stay for three days with drip.

## Family History
Father had Type 2 diabetes; died of heart attack at age 60. Mother has hypertension and osteoarthritis.

## Drug History
Currently taking Telmisartan 40 mg once daily in the morning. Currently taking Atorvastatin 10 mg once daily at night before sleep.

## Hospital Admissions
History of a three-day hospital stay for acute gastroenteritis two years ago with drip.

## General Examination & Vitals
Blood pressure is 142 by 90 mmHg. Pulse is 82 per minute. Temperature is 98.4 degree Fahrenheit. Respiratory rate is 18 per minute. Oxygen saturation is 98 percent. Weight is 78 kg, BMI is 28.2. Physical examination noted mild pallor in the eyes. Pitting edema is present up to mid shin in both legs. Heart is normal with no murmur. Lungs are clear. Abdomen is soft and does not touch the liver or spleen. Pulses are palpable in the legs, and foot palpation is safe.

## Previous Diagnosis
Hypertension for five years. High cholesterol for three years. Appendicitis and surgery at age 24. Acute gastroenteritis two years ago.

## Reports
Random blood sugar was 284 mg per dL (six months ago ECG normal).

## Current Diagnosis
New Type 2 Diabetes Mellitus due to osmotic symptoms and random blood sugar of 284 mg per dL. Stage 1 Essential Hypertension. Dyslipidemia. Edema in both legs. Early diabetic nephropathy is a possibility, though not confirmed as urine albumin was not mentioned.

## Plan of Care
Investigations ordered include fasting blood sugar tomorrow (after waking up) and postprandial blood sugar after lunch. Further investigations to be sent include HbA1c, kidney test, electrolytes, and urine albumin to creatinine ratio. A dilated fundus examination is scheduled in the eye department. Metformin 500 mg twice daily (with breakfast and dinner) for 14 days. Glimepiride 1 mg once daily, 15 minutes before breakfast. If tremors, sweating, or dizziness occur after taking Glimepiride, the patient is instructed to drink water; if it persists, they should go to casualty. Telmisartan 40 mg is to be stopped. Telmisartan will be changed to 80 mg once daily in the morning after food; the old 40 mg pill should not be taken again. Atorvastatin 10 mg remains as prescribed at night before sleep. Lifestyle modifications include avoiding sugar, sweets, refined flour, and fried foods; increasing vegetable intake; walking 30 minutes daily; washing feet in lukewarm water and drying them; and not walking barefoot. Patient is instructed to return in seven days with fasting blood sugar, postprandial blood sugar, HbA1c, and urine albumin reports to determine continuation of Metformin after the seventh day.
```

### Row #5: Dyspepsia_Male_38_2

```markdown
## Presenting Complaints
Patient reports abdominal pain and bloating for one week. The pain started after consuming spicy biryani and fried meat at a wedding last week. Patient denies nausea, fever, or black stools.

## Past History
No past medical history of hypertension, diabetes, asthma, kidney disease, or surgery. No history of cancer in the family (parents, siblings). Patient reports no regular use of medicine or painkillers.

## Family History
Not discussed

## Drug History
Patient is prescribed Omeprazole 20 mg once daily, taken on an empty stomach 30 minutes before meals for 7 days. Gelusil 10 ml is to be taken only after pain occurs during a meal. Patient was advised not to take two tablets of Omeprazole together at night.

## Hospital Admissions
Not discussed

## General Examination & Vitals
Blood pressure 120 by 78 mmHg, pulse 76 per minute, temperature 98.4 degree Fahrenheit, respiratory rate 16 per minute, oxygen saturation 99 percent, weight 70 kg. Abdomen was soft, with slight tenderness deep to the lower chest area and no guarding noted. Liver and spleen were not palpable. Bowel sounds were normal.

## Previous Diagnosis
Acute gastritis due to non-ulcer dyspepsia following consumption of spicy food and oil.

## Reports
H. pylori test result is not available in the current file, and it was not performed today.

## Current Diagnosis
Acute gastritis due to non-ulcer dyspepsia following consumption of spicy food and oil.

## Plan of Care
Omeprazole 20 mg once daily on an empty stomach 30 minutes before meals for 7 days. Gelusil 10 ml is to be taken only after pain occurs during a meal. Patient was advised to avoid fried foods, very spicy food, and excessive oil this week. Meals should be small, consumed in two or three times rather than one large meal. Avoid eating right before bedtime. Reduce tea, coffee, and cola intake. If severe abdominal pain, black stools (described as tar-like stool), vomiting, or diarrhea occurs, the patient is advised to come to the casualty department. Follow-up review is not required after seven days if symptoms subside; otherwise, return to OPD for possible H. pylori testing.
```

*(... 43 more notes saved individually in `summaries/` directory)*

