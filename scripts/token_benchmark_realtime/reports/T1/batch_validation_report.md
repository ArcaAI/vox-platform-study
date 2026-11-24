# HOPE Batch Doctor Transcript Latency & Summarization Report (Sequential)

**Generated:** 2026-11-24 08:51:30 UTC  
**Dataset Source:** `web_validation_output.csv` (48 consultations processed)  
**Gateway URL:** `https://adminconsole-vox.arcaai.com`  
**Translation Engine:** `Native Gemma-4-e2b-it-qat (GPU 0)` (Single-pass Translation & Note Gen)  
**Medical Guardrails:** `Granite-Guardian-4.1-8b (GPU 1)`  

## End-to-End Performance Summary Table

| Row # | Case / Patient | Words | Approx Tok | Status | Total E2E | S1 Init | S2 Ingest | S3 Queue | S4.1 NLP | S4.2 Grd In | S4.3 Assm | S4.4 LLM | S4.5 Grd Out | S4 Grd Tot | S5 Fetch | Throughput |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **George_Varghese_1** | 588 | 784 | PASS | **39.52s** | 1170.6ms | 886.0ms | 768.6ms | 698.2ms | 13819.3ms | 750.0ms | 3200.0ms | 17618.7ms | 31437.9ms | 605.6ms | 195.0 tps |
| 2 | **Bindu_2** | 464 | 618 | PASS | **25.03s** | 872.2ms | 755.8ms | 802.9ms | 783.6ms | 10581.9ms | 750.0ms | 3200.0ms | 6502.6ms | 17084.5ms | 785.7ms | 195.0 tps |
| 3 | **Arun_Kumar_3** | 591 | 788 | FAIL | **251.71s** | 720.8ms | 1128.8ms | 764.8ms | 673.3ms | 11733.5ms | 750.0ms | 3200.0ms | 231986.1ms | 243719.6ms | 755.9ms | 195.0 tps |
| 4 | **Type2_Diabetes_Male_54_1** | 630 | 840 | FAIL | **287.83s** | 774.9ms | 1031.7ms | 723.7ms | 2263.0ms | 12314.5ms | 750.0ms | 3200.0ms | 266157.1ms | 278471.6ms | 611.3ms | 195.0 tps |
| 5 | **Dyspepsia_Male_38_2** | 521 | 694 | PASS | **89.48s** | 916.1ms | 1751.2ms | 2593.1ms | 825.0ms | 12574.2ms | 750.0ms | 3200.0ms | 66264.9ms | 78839.1ms | 606.7ms | 195.0 tps |
| 6 | **Acute_Febrile_Illness_Male_65_3** | 656 | 874 | PASS | **63.72s** | 703.5ms | 1149.5ms | 1291.1ms | 718.3ms | 16052.8ms | 750.0ms | 3200.0ms | 39235.8ms | 55288.7ms | 614.1ms | 195.0 tps |
| 7 | **Microcytic_Anemia_Male_52_1** | 802 | 1069 | FAIL | **13.80s** | 1076.0ms | 759.5ms | 1557.0ms | 2129.1ms | 13604.1ms | 750.0ms | 3200.0ms | 1200.0ms | 14804.1ms | 4726.7ms | 195.0 tps |
| 8 | **Thrombocytopenia_Female_46_2** | 574 | 765 | PASS | **27.72s** | 910.3ms | 2566.3ms | 1806.1ms | 646.2ms | 11761.3ms | 750.0ms | 3200.0ms | 4720.4ms | 16481.6ms | 1358.2ms | 195.0 tps |
| 9 | **Cervical_Lymphadenopathy_Female_61_3** | 639 | 852 | FAIL | **341.66s** | 950.3ms | 2435.0ms | 3816.7ms | 779.6ms | 13840.3ms | 750.0ms | 3200.0ms | 315269.4ms | 329109.8ms | 622.9ms | 195.0 tps |
| 10 | **Rheumatoid_Arthritis_Female_48_1** | 685 | 913 | FAIL | **349.48s** | 804.6ms | 1902.8ms | 769.4ms | 675.9ms | 11998.1ms | 750.0ms | 3200.0ms | 328727.2ms | 340725.3ms | 651.9ms | 195.0 tps |
| 11 | **Musculoskeletal_Pain_Female_32_2** | 586 | 781 | PASS | **37.16s** | 3360.5ms | 4129.3ms | 2967.0ms | 2111.9ms | 12107.6ms | 750.0ms | 3200.0ms | 5119.5ms | 17227.1ms | 3413.3ms | 195.0 tps |
| 12 | **SLE_Workup_Female_42_3** | 654 | 872 | FAIL | **316.47s** | 1621.9ms | 1982.6ms | 776.0ms | 673.3ms | 16627.0ms | 750.0ms | 3200.0ms | 290189.3ms | 306816.2ms | 649.4ms | 195.0 tps |
| 13 | **Sanaja_Susan_Mathew_1** | 606 | 808 | PASS | **29.23s** | 831.0ms | 794.0ms | 741.5ms | 1812.6ms | 8860.9ms | 750.0ms | 3200.0ms | 11118.5ms | 19979.4ms | 1122.3ms | 195.0 tps |
| 14 | **Jancy_Biju_2** | 561 | 748 | PASS | **33.16s** | 806.1ms | 777.1ms | 804.4ms | 691.4ms | 12814.1ms | 750.0ms | 3200.0ms | 11808.1ms | 24622.2ms | 1510.5ms | 195.0 tps |
| 15 | **Joffit_Augustine_Joseph_3** | 636 | 848 | PASS | **48.67s** | 1001.6ms | 797.7ms | 750.0ms | 661.6ms | 11663.5ms | 750.0ms | 3200.0ms | 29208.3ms | 40871.7ms | 639.6ms | 195.0 tps |
| 16 | **Liju_Varghese_Thomas_1** | 610 | 813 | PASS | **24.85s** | 1093.6ms | 2955.6ms | 751.5ms | 671.4ms | 11191.3ms | 750.0ms | 3200.0ms | 3595.3ms | 14786.6ms | 637.3ms | 195.0 tps |
| 17 | **Nazeema_M_2** | 544 | 725 | PASS | **37.49s** | 972.0ms | 1028.4ms | 760.9ms | 673.2ms | 10736.9ms | 750.0ms | 3200.0ms | 18725.9ms | 29462.8ms | 643.1ms | 195.0 tps |
| 18 | **Aadarsha_S_3** | 530 | 706 | PASS | **25.69s** | 724.9ms | 800.5ms | 738.3ms | 708.0ms | 11955.7ms | 750.0ms | 3200.0ms | 6143.0ms | 18098.7ms | 674.6ms | 195.0 tps |
| 19 | **Blessy_George_1** | 809 | 1078 | FAIL | **59.08s** | 1321.4ms | 803.5ms | 3814.8ms | 666.5ms | 11137.1ms | 750.0ms | 3200.0ms | 34854.6ms | 45991.7ms | 2531.8ms | 195.0 tps |
| 20 | **Suresh_Chandran_2** | 651 | 868 | FAIL | **39.85s** | 1081.9ms | 1475.5ms | 2379.6ms | 721.5ms | 10817.7ms | 750.0ms | 3200.0ms | 18419.0ms | 29236.7ms | 1005.3ms | 195.0 tps |
| 21 | **Thiruvattal_David_Varghese_3** | 575 | 766 | FAIL | **41.86s** | 724.9ms | 755.9ms | 1578.2ms | 652.6ms | 12542.6ms | 750.0ms | 3200.0ms | 20897.0ms | 33439.6ms | 759.0ms | 195.0 tps |
| 22 | **V_Radhakrishnan_1** | 519 | 692 | FAIL | **12.38s** | 882.0ms | 762.3ms | 1382.8ms | 1146.1ms | 10729.6ms | 750.0ms | 3200.0ms | 1200.0ms | 11929.6ms | 664.1ms | 195.0 tps |
| 23 | **Loosy_M_2** | 517 | 689 | PASS | **27.18s** | 1094.5ms | 1554.2ms | 747.6ms | 673.9ms | 9580.9ms | 750.0ms | 3200.0ms | 8954.3ms | 18535.2ms | 627.6ms | 195.0 tps |
| 24 | **Ampili_T_3** | 521 | 694 | PASS | **67.47s** | 713.3ms | 1266.6ms | 2964.0ms | 992.7ms | 13415.6ms | 750.0ms | 3200.0ms | 43545.7ms | 56961.3ms | 625.5ms | 195.0 tps |
| 25 | **GI_S1_Dyspepsia_1** | 344 | 458 | PASS | **42.11s** | 730.3ms | 641.0ms | 2071.3ms | 924.5ms | 14241.5ms | 750.0ms | 3200.0ms | 18940.1ms | 33181.6ms | 615.2ms | 195.0 tps |
| 26 | **GI_S2_GI_Bleed_Followup_2** | 324 | 432 | PASS | **29.68s** | 734.4ms | 620.8ms | 777.3ms | 670.3ms | 8753.3ms | 750.0ms | 3200.0ms | 13510.5ms | 22263.8ms | 659.6ms | 195.0 tps |
| 27 | **GI_S3_Alcohol_Cirrhosis_3** | 371 | 494 | PASS | **24.59s** | 695.4ms | 622.2ms | 749.2ms | 698.1ms | 10959.6ms | 750.0ms | 3200.0ms | 6274.6ms | 17234.3ms | 639.1ms | 195.0 tps |
| 28 | **GI_S4_Obstructive_Jaundice_4** | 308 | 410 | PASS | **27.21s** | 3289.1ms | 661.8ms | 740.9ms | 676.7ms | 9499.2ms | 750.0ms | 3200.0ms | 7658.7ms | 17158.0ms | 729.7ms | 195.0 tps |
| 29 | **GI_S5_Ulcerative_Colitis_5** | 303 | 404 | PASS | **26.42s** | 979.7ms | 628.2ms | 1625.7ms | 960.6ms | 11006.2ms | 750.0ms | 3200.0ms | 6559.0ms | 17565.1ms | 712.0ms | 195.0 tps |
| 30 | **GI_S6_Chronic_Hepatitis_B_6** | 279 | 372 | PASS | **29.32s** | 721.5ms | 965.2ms | 3378.1ms | 659.5ms | 9601.9ms | 750.0ms | 3200.0ms | 9403.3ms | 19005.2ms | 637.0ms | 195.0 tps |
| 31 | **GM_S1_Diabetes_Hypertension_1** | 328 | 437 | PASS | **29.17s** | 697.5ms | 627.2ms | 768.6ms | 990.6ms | 13495.5ms | 750.0ms | 3200.0ms | 8004.6ms | 21500.0ms | 638.9ms | 195.0 tps |
| 32 | **GM_S2_Fever_2** | 286 | 381 | PASS | **26.60s** | 2062.2ms | 639.5ms | 1244.7ms | 1431.2ms | 11632.0ms | 750.0ms | 3200.0ms | 4693.8ms | 16325.8ms | 947.1ms | 195.0 tps |
| 33 | **GM_S3_Chronic_Cough_3** | 265 | 353 | PASS | **29.81s** | 686.1ms | 691.3ms | 1282.4ms | 670.0ms | 13153.8ms | 750.0ms | 3200.0ms | 8453.4ms | 21607.2ms | 918.7ms | 195.0 tps |
| 34 | **GM_S4_Anaemia_4** | 252 | 336 | PASS | **31.56s** | 2343.1ms | 949.2ms | 923.8ms | 695.6ms | 10121.1ms | 750.0ms | 3200.0ms | 11216.3ms | 21337.4ms | 1365.2ms | 195.0 tps |
| 35 | **GM_S5_Thyroid_5** | 225 | 300 | PASS | **29.75s** | 1321.7ms | 649.7ms | 798.3ms | 793.6ms | 10139.4ms | 750.0ms | 3200.0ms | 8743.7ms | 18883.1ms | 3352.2ms | 195.0 tps |
| 36 | **GM_S6_Polypharmacy_6** | 289 | 385 | PASS | **27.47s** | 729.9ms | 638.9ms | 2004.6ms | 2074.9ms | 9535.9ms | 750.0ms | 3200.0ms | 7409.8ms | 16945.7ms | 1124.8ms | 195.0 tps |
| 37 | **HM_S1_Iron_Deficiency_1** | 285 | 380 | PASS | **33.22s** | 874.7ms | 603.8ms | 1434.9ms | 1012.7ms | 12872.4ms | 750.0ms | 3200.0ms | 11836.7ms | 24709.1ms | 635.3ms | 195.0 tps |
| 38 | **HM_S2_Thalassaemia_2** | 241 | 321 | PASS | **29.15s** | 746.6ms | 2318.6ms | 937.3ms | 828.0ms | 10021.0ms | 750.0ms | 3200.0ms | 9710.5ms | 19731.5ms | 639.7ms | 195.0 tps |
| 39 | **HM_S3_ITP_3** | 274 | 365 | PASS | **26.34s** | 709.3ms | 644.7ms | 2034.8ms | 1954.9ms | 9775.4ms | 750.0ms | 3200.0ms | 5233.8ms | 15009.2ms | 2038.8ms | 195.0 tps |
| 40 | **HM_S4_Myeloma_Referral_4** | 339 | 452 | PASS | **33.61s** | 734.5ms | 634.2ms | 1873.8ms | 838.4ms | 11158.6ms | 750.0ms | 3200.0ms | 13780.8ms | 24939.4ms | 639.9ms | 195.0 tps |
| 41 | **HM_S5_Lymphoma_B_Symptoms_5** | 298 | 397 | FAIL | **30.77s** | 2169.8ms | 1131.6ms | 2116.8ms | 683.7ms | 10318.5ms | 750.0ms | 3200.0ms | 9738.8ms | 20057.3ms | 662.5ms | 195.0 tps |
| 42 | **HM_S6_Warfarin_Review_6** | 303 | 404 | FAIL (Session Init) | **0.62s** | 619.5ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | - |
| 43 | **RH_S1_Early_RA_1** | 352 | 469 | FAIL (Session Init) | **0.61s** | 606.8ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | - |
| 44 | **RH_S2_SLE_2** | 304 | 405 | FAIL (Session Init) | **0.65s** | 650.2ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | - |
| 45 | **RH_S3_Axial_Spondyloarthritis_3** | 281 | 374 | FAIL (Session Init) | **0.62s** | 617.9ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | - |
| 46 | **RH_S4_Gout_4** | 268 | 357 | FAIL (Session Init) | **0.62s** | 621.4ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | - |
| 47 | **RH_S5_Knee_Osteoarthritis_5** | 247 | 329 | FAIL (Session Init) | **0.60s** | 595.4ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | - |
| 48 | **RH_S6_Psoriatic_Arthritis_6** | 245 | 326 | FAIL (Session Init) | **0.62s** | 617.8ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | 0.0ms | - |

## Dedicated GPU Hardware Telemetry

| Row # | Case / Patient | Prefill TTFT | LLM Decode | Guardrail GPU | Peak VRAM | Delta VRAM | GPU Avg Util |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **George_Varghese_1** | 1097.4ms | 2102.6ms | 31437.9ms | 7.85 GB | +376 MB | 45.6% |
| 2 | **Bindu_2** | 1097.4ms | 2102.6ms | 17084.5ms | 7.77 GB | +297 MB | 44.9% |
| 3 | **Arun_Kumar_3** | 1097.4ms | 2102.6ms | 243719.6ms | 7.85 GB | +378 MB | 45.7% |
| 4 | **Type2_Diabetes_Male_54_1** | 1097.4ms | 2102.6ms | 278471.6ms | 7.87 GB | +403 MB | 45.9% |
| 5 | **Dyspepsia_Male_38_2** | 1097.4ms | 2102.6ms | 78839.1ms | 7.81 GB | +333 MB | 45.2% |
| 6 | **Acute_Febrile_Illness_Male_65_3** | 1097.4ms | 2102.6ms | 55288.7ms | 7.89 GB | +420 MB | 46.1% |
| 7 | **Microcytic_Anemia_Male_52_1** | 1097.4ms | 2102.6ms | 14804.1ms | 7.98 GB | +513 MB | 47.0% |
| 8 | **Thrombocytopenia_Female_46_2** | 1097.4ms | 2102.6ms | 16481.6ms | 7.84 GB | +367 MB | 45.6% |
| 9 | **Cervical_Lymphadenopathy_Female_61_3** | 1097.4ms | 2102.6ms | 329109.8ms | 7.88 GB | +409 MB | 46.0% |
| 10 | **Rheumatoid_Arthritis_Female_48_1** | 1097.4ms | 2102.6ms | 340725.3ms | 7.91 GB | +438 MB | 46.2% |
| 11 | **Musculoskeletal_Pain_Female_32_2** | 1097.4ms | 2102.6ms | 17227.1ms | 7.85 GB | +375 MB | 45.6% |
| 12 | **SLE_Workup_Female_42_3** | 1097.4ms | 2102.6ms | 306816.2ms | 7.89 GB | +419 MB | 46.1% |
| 13 | **Sanaja_Susan_Mathew_1** | 1097.4ms | 2102.6ms | 19979.4ms | 7.86 GB | +388 MB | 45.8% |
| 14 | **Jancy_Biju_2** | 1097.4ms | 2102.6ms | 24622.2ms | 7.83 GB | +359 MB | 45.5% |
| 15 | **Joffit_Augustine_Joseph_3** | 1097.4ms | 2102.6ms | 40871.7ms | 7.88 GB | +407 MB | 45.9% |
| 16 | **Liju_Varghese_Thomas_1** | 1097.4ms | 2102.6ms | 14786.6ms | 7.86 GB | +390 MB | 45.8% |
| 17 | **Nazeema_M_2** | 1097.4ms | 2102.6ms | 29462.8ms | 7.82 GB | +348 MB | 45.4% |
| 18 | **Aadarsha_S_3** | 1097.4ms | 2102.6ms | 18098.7ms | 7.81 GB | +339 MB | 45.3% |
| 19 | **Blessy_George_1** | 1097.4ms | 2102.6ms | 45991.7ms | 7.99 GB | +517 MB | 47.0% |
| 20 | **Suresh_Chandran_2** | 1097.4ms | 2102.6ms | 29236.7ms | 7.89 GB | +417 MB | 46.0% |
| 21 | **Thiruvattal_David_Varghese_3** | 1097.4ms | 2102.6ms | 33439.6ms | 7.84 GB | +368 MB | 45.6% |
| 22 | **V_Radhakrishnan_1** | 1097.4ms | 2102.6ms | 11929.6ms | 7.80 GB | +332 MB | 45.2% |
| 23 | **Loosy_M_2** | 1097.4ms | 2102.6ms | 18535.2ms | 7.80 GB | +331 MB | 45.2% |
| 24 | **Ampili_T_3** | 1097.4ms | 2102.6ms | 56961.3ms | 7.81 GB | +333 MB | 45.2% |
| 25 | **GI_S1_Dyspepsia_1** | 1097.4ms | 2102.6ms | 33181.6ms | 7.69 GB | +220 MB | 44.1% |
| 26 | **GI_S2_GI_Bleed_Followup_2** | 1097.4ms | 2102.6ms | 22263.8ms | 7.68 GB | +207 MB | 44.0% |
| 27 | **GI_S3_Alcohol_Cirrhosis_3** | 1097.4ms | 2102.6ms | 17234.3ms | 7.71 GB | +237 MB | 44.3% |
| 28 | **GI_S4_Obstructive_Jaundice_4** | 1097.4ms | 2102.6ms | 17158.0ms | 7.67 GB | +197 MB | 43.9% |
| 29 | **GI_S5_Ulcerative_Colitis_5** | 1097.4ms | 2102.6ms | 17565.1ms | 7.67 GB | +194 MB | 43.9% |
| 30 | **GI_S6_Chronic_Hepatitis_B_6** | 1097.4ms | 2102.6ms | 19005.2ms | 7.65 GB | +179 MB | 43.7% |
| 31 | **GM_S1_Diabetes_Hypertension_1** | 1097.4ms | 2102.6ms | 21500.0ms | 7.68 GB | +210 MB | 44.0% |
| 32 | **GM_S2_Fever_2** | 1097.4ms | 2102.6ms | 16325.8ms | 7.66 GB | +183 MB | 43.8% |
| 33 | **GM_S3_Chronic_Cough_3** | 1097.4ms | 2102.6ms | 21607.2ms | 7.65 GB | +169 MB | 43.6% |
| 34 | **GM_S4_Anaemia_4** | 1097.4ms | 2102.6ms | 21337.4ms | 7.64 GB | +161 MB | 43.6% |
| 35 | **GM_S5_Thyroid_5** | 1097.4ms | 2102.6ms | 18883.1ms | 7.62 GB | +144 MB | 43.4% |
| 36 | **GM_S6_Polypharmacy_6** | 1097.4ms | 2102.6ms | 16945.7ms | 7.66 GB | +185 MB | 43.8% |
| 37 | **HM_S1_Iron_Deficiency_1** | 1097.4ms | 2102.6ms | 24709.1ms | 7.66 GB | +182 MB | 43.8% |
| 38 | **HM_S2_Thalassaemia_2** | 1097.4ms | 2102.6ms | 19731.5ms | 7.63 GB | +154 MB | 43.5% |
| 39 | **HM_S3_ITP_3** | 1097.4ms | 2102.6ms | 15009.2ms | 7.65 GB | +175 MB | 43.7% |
| 40 | **HM_S4_Myeloma_Referral_4** | 1097.4ms | 2102.6ms | 24939.4ms | 7.69 GB | +217 MB | 44.1% |
| 41 | **HM_S5_Lymphoma_B_Symptoms_5** | 1097.4ms | 2102.6ms | 20057.3ms | 7.67 GB | +191 MB | 43.8% |
| 42 | **HM_S6_Warfarin_Review_6** | 0.0ms | 0.0ms | 0.0ms | 7.79 GB | +320 MB | 45.0% |
| 43 | **RH_S1_Early_RA_1** | 0.0ms | 0.0ms | 0.0ms | 7.79 GB | +320 MB | 45.0% |
| 44 | **RH_S2_SLE_2** | 0.0ms | 0.0ms | 0.0ms | 7.79 GB | +320 MB | 45.0% |
| 45 | **RH_S3_Axial_Spondyloarthritis_3** | 0.0ms | 0.0ms | 0.0ms | 7.79 GB | +320 MB | 45.0% |
| 46 | **RH_S4_Gout_4** | 0.0ms | 0.0ms | 0.0ms | 7.79 GB | +320 MB | 45.0% |
| 47 | **RH_S5_Knee_Osteoarthritis_5** | 0.0ms | 0.0ms | 0.0ms | 7.79 GB | +320 MB | 45.0% |
| 48 | **RH_S6_Psoriatic_Arthritis_6** | 0.0ms | 0.0ms | 0.0ms | 7.79 GB | +320 MB | 45.0% |

## Generated Clinical Notes (Sample Section)

### Row #1: George_Varghese_1

```markdown
## Presenting Complaints
1. Epigastric pain and burning sensation in the chest for three months, worsening after meals, described as feeling like fire spreading to the throat.

## Past History
• Onset: Three months ago.
• Progression: Worsening after meals; occurs at night while lying down.
• Aggravating factors: Eating oily and spicy foods.
• Associated symptoms: Burning sensation in the chest, feeling like fire spreading to the throat, pain and fluid coming into the throat when lying down.
• Negative symptoms: No history of vomiting or black stools reported.

## Family History
- Father had hypertension.
- Older brother has diabetes.

## Drug History
- Patient takes Gelusil for temporary relief, but no regular medication is prescribed.
- Prior to today's consultation, the patient was taking Sompraz D (containing esomeprazole 40 mg and domperidone 30 mg) once daily before food for 30 days.

## Hospital Admissions
- Open appendectomy performed at age 22 for appendicitis.

## General Examination & Vitals
General examination revealed soft abdomen with mild tenderness below the chest area; no guarding or rigidity noted. Bowel sounds were normal. Liver and spleen were non-tender to palpation. Vital signs recorded: Blood pressure 124 by 82 mmHg, pulse 76 per minute, temperature 98.4 degree Fahrenheit, respiratory rate 16 per minute, oxygen saturation 99 percent. Patient reported weight of 74 kg and denied pallor or icterus.

## Previous Diagnosis
- Gastroesophageal reflux disease with Grade B esophagitis (endoscopy findings).

## Reports
- Upper GI endoscopy showed Grade B reflux esophagitis, described as a small fissure, not an ulcer.

## Current Diagnosis
Gastroesophageal reflux disease with Grade B esophagitis.

## Plan of Care
Medications Prescribed: Sompraz D (containing esomeprazole 40 mg and domperidone 30 mg) once daily before food for 30 days. Mucaine 10 ml three times daily one hour after meals for 14 days.
Investigations & Procedures Ordered: None ordered today, as endoscopy report was reviewed.
Dietary & Lifestyle Advice: Patient was advised to reduce spicy and fried foods and late-night meals. Patient was instructed not to lie down for two hours after eating or consume tea and coffee on an empty stomach. Patient was advised to stop work temporarily. Red flag warnings included seeking casualty care if hematemesis, black stools, or unbearable chest pain occurred.
Follow up date: Review in two weeks with the endoscopy report.
```

### Row #2: Bindu_2

```markdown
## Presenting Complaints
1. Gallbladder polyp noted on school checkup ultrasound, measuring 4 millimeter.

## Past History
Not discussed

## Family History
Not discussed

## Drug History
Not discussed

## Hospital Admissions
Not discussed

## General Examination & Vitals
General examination: Abdomen soft, no tenderness, Murphy sign negative. Liver and spleen non-palpable. Vital signs: Blood pressure 118 by 76 mmHg, pulse 72 per minute, temperature 98.2 degree Fahrenheit, respiratory rate 16 per minute, oxygen saturation 99 percent, weight 62 kg.

## Previous Diagnosis
Not discussed

## Reports
- Ultrasound showed a gallbladder polyp measuring 4 millimeter.
- Liver was normal.
- Gallbladder wall was thin.
- Common bile duct was normal.

## Current Diagnosis
Asymptomatic gallbladder polyp, 4 millimeter.

## Plan of Care
Medications Prescribed: None prescribed today.
Investigations & Procedures Ordered: Abdominal ultrasound to be performed in six months to monitor the 4 millimeter polyp size.
Dietary & Lifestyle Advice: Patient was advised to increase vegetables and fiber intake and reduce fat. Patient was counseled on seeking casualty care if unbearable pain, fever, or jaundice occurred. Patient was instructed not to fast at home as there was no current pain. 
Patient Education & Red Flag Warnings: Patient was instructed to return with the ultrasound report in six months. Patient was advised that if the size increases towards 10 millimeter, they should consult immediately.
```

### Row #3: Arun_Kumar_3

*(No note content retrieved)*

### Row #4: Type2_Diabetes_Male_54_1

*(No note content retrieved)*

### Row #5: Dyspepsia_Male_38_2

```markdown
## Presenting Complaints
1. Pain and swelling below the chest area, present for one week, started after consuming spicy biryani and fried meat last week.

## Past History
- Onset: Gradual, following consumption of spicy food.
- Duration: One week.
- Progression: Static/Mild tenderness reported upon deep palpation.
- Aggravating or relieving factors: Related to eating spicy food; pain is manageable.
- Associated positive symptoms: None reported (no fever, no vomiting).
- Associated negative symptoms: No nausea, no diarrhea, no blood in stool, no weight loss.

## Family History
Not discussed

## Drug History
- Omeprazole 20 mg once daily in the morning before food for 7 days.
- Gelusil 10 ml after meals if pain occurs.

## Hospital Admissions
Not discussed

## General Examination & Vitals
General examination revealed soft abdomen with slight tenderness deep below the chest area. Liver and spleen were non-palpable. Bowel sounds were normal.
Vital signs: Blood pressure 120 by 78 mmHg, pulse 76 per minute, temperature 98.4 degree Fahrenheit, respiratory rate 16 per minute, oxygen saturation 99 percent, weight 70 kg.

## Previous Diagnosis
- Acute gastritis
- Non-ulcer dyspepsia following spicy food intake.

## Reports
Not discussed

## Current Diagnosis
Acute gastritis; Non-ulcer dyspepsia.

## Plan of Care
- Medications Prescribed: Omeprazole 20 mg once daily in the morning before food for 7 days. Gelusil 10 ml after meals if pain occurs.
- Dietary & Lifestyle Advice: Avoid fried and very spicy foods this week. Eat meals in smaller portions, two or three times a day. Do not eat a full stomach at one time. Reduce intake of tea, coffee, and cola. Eat dinner early, avoiding eating immediately before sleep.
- Patient Education & Red Flag Warnings: The patient was instructed to seek casualty if severe abdominal pain, black tarry stools (melena), vomiting, or sudden increase in abdominal girth. If omeprazole is missed, one dose may be taken at noon the next day. Review after 7 days with the report; return to OPD if pain persists. H pylori test can be performed then.
```

*(... 43 more notes saved individually in `summaries/` directory)*

