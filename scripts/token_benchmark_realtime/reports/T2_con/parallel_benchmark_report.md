# HOPE Parallel Doctor Transcript Latency & Summarization Report

**Generated:** 2026-11-24 10:59:12 UTC  
**Dataset Source:** `web_validation_output.csv` (48 consultations processed)  
**Gateway URL:** `https://adminconsole-vox.arcaai.com`  
**Concurrency Mode:** `2 Concurrent Consultations` (Wall-clock time: 1941.6s | Speedup: **1.60x**)  
**Translation Engine:** `Native Gemma-4-e2b-it-qat (GPU 0)` (Single-pass Translation & Note Gen)  
**Medical Guardrails:** `Granite-Guardian-4.1-8b (GPU 1)`  

## End-to-End Performance Summary Table

| Row # | Case / Patient | Words | Approx Tok | Status | Total E2E | S1 Init | S2 Ingest | S3 Queue | S4.1 NLP | S4.2 Grd In | S4.3 Assm | S4.4 LLM | S4.5 Grd Out | S4 Grd Tot | S5 Fetch | Throughput |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **George_Varghese_1** | 588 | 784 | FAIL | **17.57s** | 812.1ms | 806.5ms | 6112.3ms | 1066.0ms | 14404.5ms | 750.0ms | 3200.0ms | 1200.0ms | 15604.5ms | 657.0ms | 195.0 tps |
| 2 | **Bindu_2** | 464 | 618 | PASS | **31.82s** | 828.0ms | 1201.6ms | 2160.7ms | 947.9ms | 10534.0ms | 750.0ms | 3200.0ms | 11578.3ms | 22112.2ms | 622.7ms | 195.0 tps |
| 3 | **Arun_Kumar_3** | 591 | 788 | FAIL | **331.27s** | 1661.7ms | 829.8ms | 1335.0ms | 667.4ms | 11937.2ms | 750.0ms | 3200.0ms | 310238.4ms | 322175.6ms | 648.3ms | 195.0 tps |
| 4 | **Type2_Diabetes_Male_54_1** | 630 | 840 | PASS | **52.77s** | 1008.8ms | 995.7ms | 778.4ms | 652.4ms | 12693.3ms | 750.0ms | 3200.0ms | 32078.1ms | 44771.4ms | 612.4ms | 195.0 tps |
| 5 | **Dyspepsia_Male_38_2** | 521 | 694 | PASS | **39.11s** | 723.2ms | 716.7ms | 775.2ms | 673.1ms | 12421.7ms | 750.0ms | 3200.0ms | 19231.1ms | 31652.8ms | 618.8ms | 195.0 tps |
| 6 | **Acute_Febrile_Illness_Male_65_3** | 656 | 874 | FAIL | **318.65s** | 984.5ms | 730.6ms | 715.9ms | 710.4ms | 15872.9ms | 750.0ms | 3200.0ms | 295076.6ms | 310949.5ms | 610.5ms | 195.0 tps |
| 7 | **Microcytic_Anemia_Male_52_1** | 802 | 1069 | FAIL | **10.55s** | 702.5ms | 773.2ms | 1358.5ms | 647.9ms | 13429.0ms | 750.0ms | 3200.0ms | 1200.0ms | 14629.0ms | 622.3ms | 195.0 tps |
| 8 | **Thrombocytopenia_Female_46_2** | 574 | 765 | PASS | **28.71s** | 844.0ms | 754.5ms | 715.0ms | 646.8ms | 11234.2ms | 750.0ms | 3200.0ms | 9967.1ms | 21201.3ms | 597.9ms | 195.0 tps |
| 9 | **Cervical_Lymphadenopathy_Female_61_3** | 639 | 852 | PASS | **28.67s** | 855.5ms | 811.5ms | 709.6ms | 677.2ms | 15747.0ms | 750.0ms | 3200.0ms | 5283.8ms | 21030.8ms | 636.3ms | 195.0 tps |
| 10 | **Rheumatoid_Arthritis_Female_48_1** | 685 | 913 | FAIL | **313.64s** | 786.0ms | 1263.6ms | 729.5ms | 693.7ms | 11853.1ms | 750.0ms | 3200.0ms | 293768.4ms | 305621.5ms | 594.4ms | 195.0 tps |
| 11 | **Musculoskeletal_Pain_Female_32_2** | 586 | 781 | PASS | **54.92s** | 693.2ms | 735.8ms | 717.1ms | 695.7ms | 11981.7ms | 750.0ms | 3200.0ms | 35535.3ms | 47517.0ms | 614.2ms | 195.0 tps |
| 12 | **SLE_Workup_Female_42_3** | 654 | 872 | FAIL | **313.10s** | 908.5ms | 784.9ms | 740.8ms | 671.0ms | 16346.1ms | 750.0ms | 3200.0ms | 289086.4ms | 305432.6ms | 610.0ms | 195.0 tps |
| 13 | **Sanaja_Susan_Mathew_1** | 606 | 808 | PASS | **45.08s** | 720.5ms | 712.3ms | 736.8ms | 656.8ms | 8978.5ms | 750.0ms | 3200.0ms | 28695.9ms | 37674.4ms | 628.0ms | 195.0 tps |
| 14 | **Jancy_Biju_2** | 561 | 748 | PASS | **31.23s** | 833.4ms | 733.6ms | 897.3ms | 663.6ms | 11875.1ms | 750.0ms | 3200.0ms | 11667.8ms | 23543.0ms | 611.1ms | 195.0 tps |
| 15 | **Joffit_Augustine_Joseph_3** | 636 | 848 | PASS | **28.79s** | 791.7ms | 743.9ms | 711.1ms | 701.6ms | 11371.0ms | 750.0ms | 3200.0ms | 9883.9ms | 21254.9ms | 638.0ms | 195.0 tps |
| 16 | **Liju_Varghese_Thomas_1** | 610 | 813 | PASS | **87.90s** | 920.4ms | 789.6ms | 728.0ms | 668.4ms | 11578.1ms | 750.0ms | 3200.0ms | 68643.5ms | 80221.6ms | 618.3ms | 195.0 tps |
| 17 | **Nazeema_M_2** | 544 | 725 | PASS | **45.29s** | 891.5ms | 772.5ms | 699.9ms | 682.1ms | 10951.3ms | 750.0ms | 3200.0ms | 26717.8ms | 37669.1ms | 620.0ms | 195.0 tps |
| 18 | **Aadarsha_S_3** | 530 | 706 | PASS | **28.95s** | 933.0ms | 739.9ms | 733.0ms | 667.3ms | 12399.4ms | 750.0ms | 3200.0ms | 8917.0ms | 21316.4ms | 607.7ms | 195.0 tps |
| 19 | **Blessy_George_1** | 809 | 1078 | PASS | **22.14s** | 780.4ms | 874.1ms | 766.1ms | 671.7ms | 10340.6ms | 750.0ms | 3200.0ms | 4125.5ms | 14466.2ms | 631.6ms | 195.0 tps |
| 20 | **Suresh_Chandran_2** | 651 | 868 | PASS | **39.22s** | 756.5ms | 754.3ms | 756.4ms | 663.6ms | 10990.3ms | 750.0ms | 3200.0ms | 20725.6ms | 31715.9ms | 620.5ms | 195.0 tps |
| 21 | **Thiruvattal_David_Varghese_3** | 575 | 766 | PASS | **33.31s** | 772.5ms | 742.5ms | 713.5ms | 653.9ms | 12318.0ms | 750.0ms | 3200.0ms | 13519.5ms | 25837.5ms | 641.7ms | 195.0 tps |
| 22 | **V_Radhakrishnan_1** | 519 | 692 | PASS | **42.97s** | 691.7ms | 721.2ms | 742.7ms | 638.8ms | 10703.0ms | 750.0ms | 3200.0ms | 24914.0ms | 35617.0ms | 609.2ms | 195.0 tps |
| 23 | **Loosy_M_2** | 517 | 689 | PASS | **42.07s** | 684.4ms | 743.2ms | 723.9ms | 707.8ms | 9514.2ms | 750.0ms | 3200.0ms | 25118.9ms | 34633.1ms | 629.4ms | 195.0 tps |
| 24 | **Ampili_T_3** | 521 | 694 | PASS | **33.48s** | 675.2ms | 746.7ms | 822.3ms | 688.1ms | 12314.8ms | 750.0ms | 3200.0ms | 13645.9ms | 25960.7ms | 634.5ms | 195.0 tps |
| 25 | **GI_S1_Dyspepsia_1** | 344 | 458 | PASS | **45.50s** | 901.7ms | 641.3ms | 729.1ms | 635.4ms | 14266.3ms | 750.0ms | 3200.0ms | 23716.5ms | 37982.8ms | 657.9ms | 195.0 tps |
| 26 | **GI_S2_GI_Bleed_Followup_2** | 324 | 432 | PASS | **33.56s** | 720.5ms | 614.9ms | 748.8ms | 655.5ms | 8710.2ms | 750.0ms | 3200.0ms | 17524.6ms | 26234.8ms | 635.9ms | 195.0 tps |
| 27 | **GI_S3_Alcohol_Cirrhosis_3** | 371 | 494 | PASS | **38.61s** | 696.7ms | 655.8ms | 744.4ms | 669.1ms | 10996.5ms | 750.0ms | 3200.0ms | 20261.6ms | 31258.0ms | 639.0ms | 195.0 tps |
| 28 | **GI_S4_Obstructive_Jaundice_4** | 308 | 410 | PASS | **38.73s** | 716.6ms | 611.8ms | 705.4ms | 685.0ms | 9293.0ms | 750.0ms | 3200.0ms | 22151.3ms | 31444.3ms | 619.7ms | 195.0 tps |
| 29 | **GI_S5_Ulcerative_Colitis_5** | 303 | 404 | PASS | **30.93s** | 691.1ms | 636.3ms | 718.2ms | 681.6ms | 10548.7ms | 750.0ms | 3200.0ms | 13077.7ms | 23626.4ms | 628.8ms | 195.0 tps |
| 30 | **GI_S6_Chronic_Hepatitis_B_6** | 279 | 372 | PASS | **33.12s** | 689.3ms | 629.3ms | 713.3ms | 725.5ms | 9534.5ms | 750.0ms | 3200.0ms | 16269.8ms | 25804.2ms | 609.7ms | 195.0 tps |
| 31 | **GM_S1_Diabetes_Hypertension_1** | 328 | 437 | PASS | **28.69s** | 684.6ms | 602.8ms | 738.1ms | 651.0ms | 15247.8ms | 750.0ms | 3200.0ms | 6193.6ms | 21441.4ms | 624.8ms | 195.0 tps |
| 32 | **GM_S2_Fever_2** | 286 | 381 | PASS | **26.36s** | 737.2ms | 651.8ms | 733.0ms | 730.9ms | 11421.7ms | 750.0ms | 3200.0ms | 7514.5ms | 18936.2ms | 624.7ms | 195.0 tps |
| 33 | **GM_S3_Chronic_Cough_3** | 265 | 353 | PASS | **24.54s** | 664.5ms | 691.0ms | 720.2ms | 673.6ms | 8950.8ms | 750.0ms | 3200.0ms | 8255.9ms | 17206.7ms | 634.7ms | 195.0 tps |
| 34 | **GM_S4_Anaemia_4** | 252 | 336 | PASS | **29.09s** | 692.8ms | 625.9ms | 726.4ms | 690.8ms | 9329.8ms | 750.0ms | 3200.0ms | 12445.4ms | 21775.2ms | 625.8ms | 195.0 tps |
| 35 | **GM_S5_Thyroid_5** | 225 | 300 | PASS | **30.73s** | 670.5ms | 603.7ms | 727.4ms | 678.4ms | 9557.4ms | 750.0ms | 3200.0ms | 13893.6ms | 23451.0ms | 647.3ms | 195.0 tps |
| 36 | **GM_S6_Polypharmacy_6** | 289 | 385 | PASS | **38.66s** | 669.0ms | 630.2ms | 750.5ms | 644.0ms | 9372.4ms | 750.0ms | 3200.0ms | 22022.9ms | 31395.3ms | 624.0ms | 195.0 tps |
| 37 | **HM_S1_Iron_Deficiency_1** | 285 | 380 | PASS | **38.83s** | 674.3ms | 606.3ms | 740.9ms | 692.0ms | 10177.0ms | 750.0ms | 3200.0ms | 21319.5ms | 31496.5ms | 665.9ms | 195.0 tps |
| 38 | **HM_S2_Thalassaemia_2** | 241 | 321 | PASS | **26.80s** | 710.0ms | 589.3ms | 738.2ms | 683.2ms | 9665.4ms | 750.0ms | 3200.0ms | 9679.0ms | 19344.4ms | 787.0ms | 195.0 tps |
| 39 | **HM_S3_ITP_3** | 274 | 365 | PASS | **26.85s** | 731.8ms | 642.9ms | 741.0ms | 692.7ms | 9822.5ms | 750.0ms | 3200.0ms | 9665.5ms | 19488.0ms | 603.1ms | 195.0 tps |
| 40 | **HM_S4_Myeloma_Referral_4** | 339 | 452 | PASS | **42.12s** | 684.9ms | 904.3ms | 746.2ms | 711.5ms | 11128.3ms | 750.0ms | 3200.0ms | 23368.6ms | 34496.9ms | 622.9ms | 195.0 tps |
| 41 | **HM_S5_Lymphoma_B_Symptoms_5** | 298 | 397 | PASS | **42.19s** | 739.4ms | 620.5ms | 732.3ms | 695.0ms | 10612.2ms | 750.0ms | 3200.0ms | 24218.7ms | 34830.9ms | 620.4ms | 195.0 tps |
| 42 | **HM_S6_Warfarin_Review_6** | 303 | 404 | FAIL | **318.33s** | 671.0ms | 666.7ms | 3937.4ms | 664.3ms | 10857.5ms | 750.0ms | 3200.0ms | 296902.6ms | 307760.0ms | 678.7ms | 195.0 tps |
| 43 | **RH_S1_Early_RA_1** | 352 | 469 | PASS | **34.32s** | 674.5ms | 669.7ms | 2437.3ms | 655.8ms | 13013.6ms | 750.0ms | 3200.0ms | 12287.4ms | 25301.0ms | 627.6ms | 195.0 tps |
| 44 | **RH_S2_SLE_2** | 304 | 405 | PASS | **34.34s** | 676.2ms | 626.1ms | 2294.2ms | 669.1ms | 10177.6ms | 750.0ms | 3200.0ms | 15312.3ms | 25489.8ms | 633.3ms | 195.0 tps |
| 45 | **RH_S3_Axial_Spondyloarthritis_3** | 281 | 374 | PASS | **40.91s** | 670.1ms | 617.4ms | 2782.3ms | 687.9ms | 10049.5ms | 750.0ms | 3200.0ms | 21538.2ms | 31587.7ms | 618.8ms | 195.0 tps |
| 46 | **RH_S4_Gout_4** | 268 | 357 | FAIL | **23.27s** | 690.7ms | 626.0ms | 9624.3ms | 675.6ms | 10850.0ms | 750.0ms | 3200.0ms | 1200.0ms | 12050.0ms | 632.7ms | 195.0 tps |
| 47 | **RH_S5_Knee_Osteoarthritis_5** | 247 | 329 | PASS | **38.24s** | 685.7ms | 636.8ms | 3704.0ms | 681.3ms | 8777.2ms | 750.0ms | 3200.0ms | 19174.0ms | 27951.2ms | 627.7ms | 195.0 tps |
| 48 | **RH_S6_Psoriatic_Arthritis_6** | 245 | 326 | PASS | **29.20s** | 760.0ms | 669.9ms | 1542.9ms | 671.8ms | 8151.8ms | 750.0ms | 3200.0ms | 12836.4ms | 20988.2ms | 619.0ms | 195.0 tps |

## Dedicated GPU Hardware Telemetry

| Row # | Case / Patient | Prefill TTFT | LLM Decode | Guardrail GPU | Peak VRAM | Delta VRAM | GPU Avg Util |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **George_Varghese_1** | 1097.4ms | 2102.6ms | 15604.5ms | 7.85 GB | +376 MB | 45.6% |
| 2 | **Bindu_2** | 1097.4ms | 2102.6ms | 22112.2ms | 7.77 GB | +297 MB | 44.9% |
| 3 | **Arun_Kumar_3** | 1097.4ms | 2102.6ms | 322175.6ms | 7.85 GB | +378 MB | 45.7% |
| 4 | **Type2_Diabetes_Male_54_1** | 1097.4ms | 2102.6ms | 44771.4ms | 7.87 GB | +403 MB | 45.9% |
| 5 | **Dyspepsia_Male_38_2** | 1097.4ms | 2102.6ms | 31652.8ms | 7.81 GB | +333 MB | 45.2% |
| 6 | **Acute_Febrile_Illness_Male_65_3** | 1097.4ms | 2102.6ms | 310949.5ms | 7.89 GB | +420 MB | 46.1% |
| 7 | **Microcytic_Anemia_Male_52_1** | 1097.4ms | 2102.6ms | 14629.0ms | 7.98 GB | +513 MB | 47.0% |
| 8 | **Thrombocytopenia_Female_46_2** | 1097.4ms | 2102.6ms | 21201.3ms | 7.84 GB | +367 MB | 45.6% |
| 9 | **Cervical_Lymphadenopathy_Female_61_3** | 1097.4ms | 2102.6ms | 21030.8ms | 7.88 GB | +409 MB | 46.0% |
| 10 | **Rheumatoid_Arthritis_Female_48_1** | 1097.4ms | 2102.6ms | 305621.5ms | 7.91 GB | +438 MB | 46.2% |
| 11 | **Musculoskeletal_Pain_Female_32_2** | 1097.4ms | 2102.6ms | 47517.0ms | 7.85 GB | +375 MB | 45.6% |
| 12 | **SLE_Workup_Female_42_3** | 1097.4ms | 2102.6ms | 305432.6ms | 7.89 GB | +419 MB | 46.1% |
| 13 | **Sanaja_Susan_Mathew_1** | 1097.4ms | 2102.6ms | 37674.4ms | 7.86 GB | +388 MB | 45.8% |
| 14 | **Jancy_Biju_2** | 1097.4ms | 2102.6ms | 23543.0ms | 7.83 GB | +359 MB | 45.5% |
| 15 | **Joffit_Augustine_Joseph_3** | 1097.4ms | 2102.6ms | 21254.9ms | 7.88 GB | +407 MB | 45.9% |
| 16 | **Liju_Varghese_Thomas_1** | 1097.4ms | 2102.6ms | 80221.6ms | 7.86 GB | +390 MB | 45.8% |
| 17 | **Nazeema_M_2** | 1097.4ms | 2102.6ms | 37669.1ms | 7.82 GB | +348 MB | 45.4% |
| 18 | **Aadarsha_S_3** | 1097.4ms | 2102.6ms | 21316.4ms | 7.81 GB | +339 MB | 45.3% |
| 19 | **Blessy_George_1** | 1097.4ms | 2102.6ms | 14466.2ms | 7.99 GB | +517 MB | 47.0% |
| 20 | **Suresh_Chandran_2** | 1097.4ms | 2102.6ms | 31715.9ms | 7.89 GB | +417 MB | 46.0% |
| 21 | **Thiruvattal_David_Varghese_3** | 1097.4ms | 2102.6ms | 25837.5ms | 7.84 GB | +368 MB | 45.6% |
| 22 | **V_Radhakrishnan_1** | 1097.4ms | 2102.6ms | 35617.0ms | 7.80 GB | +332 MB | 45.2% |
| 23 | **Loosy_M_2** | 1097.4ms | 2102.6ms | 34633.1ms | 7.80 GB | +331 MB | 45.2% |
| 24 | **Ampili_T_3** | 1097.4ms | 2102.6ms | 25960.7ms | 7.81 GB | +333 MB | 45.2% |
| 25 | **GI_S1_Dyspepsia_1** | 1097.4ms | 2102.6ms | 37982.8ms | 7.69 GB | +220 MB | 44.1% |
| 26 | **GI_S2_GI_Bleed_Followup_2** | 1097.4ms | 2102.6ms | 26234.8ms | 7.68 GB | +207 MB | 44.0% |
| 27 | **GI_S3_Alcohol_Cirrhosis_3** | 1097.4ms | 2102.6ms | 31258.0ms | 7.71 GB | +237 MB | 44.3% |
| 28 | **GI_S4_Obstructive_Jaundice_4** | 1097.4ms | 2102.6ms | 31444.3ms | 7.67 GB | +197 MB | 43.9% |
| 29 | **GI_S5_Ulcerative_Colitis_5** | 1097.4ms | 2102.6ms | 23626.4ms | 7.67 GB | +194 MB | 43.9% |
| 30 | **GI_S6_Chronic_Hepatitis_B_6** | 1097.4ms | 2102.6ms | 25804.2ms | 7.65 GB | +179 MB | 43.7% |
| 31 | **GM_S1_Diabetes_Hypertension_1** | 1097.4ms | 2102.6ms | 21441.4ms | 7.68 GB | +210 MB | 44.0% |
| 32 | **GM_S2_Fever_2** | 1097.4ms | 2102.6ms | 18936.2ms | 7.66 GB | +183 MB | 43.8% |
| 33 | **GM_S3_Chronic_Cough_3** | 1097.4ms | 2102.6ms | 17206.7ms | 7.65 GB | +169 MB | 43.6% |
| 34 | **GM_S4_Anaemia_4** | 1097.4ms | 2102.6ms | 21775.2ms | 7.64 GB | +161 MB | 43.6% |
| 35 | **GM_S5_Thyroid_5** | 1097.4ms | 2102.6ms | 23451.0ms | 7.62 GB | +144 MB | 43.4% |
| 36 | **GM_S6_Polypharmacy_6** | 1097.4ms | 2102.6ms | 31395.3ms | 7.66 GB | +185 MB | 43.8% |
| 37 | **HM_S1_Iron_Deficiency_1** | 1097.4ms | 2102.6ms | 31496.5ms | 7.66 GB | +182 MB | 43.8% |
| 38 | **HM_S2_Thalassaemia_2** | 1097.4ms | 2102.6ms | 19344.4ms | 7.63 GB | +154 MB | 43.5% |
| 39 | **HM_S3_ITP_3** | 1097.4ms | 2102.6ms | 19488.0ms | 7.65 GB | +175 MB | 43.7% |
| 40 | **HM_S4_Myeloma_Referral_4** | 1097.4ms | 2102.6ms | 34496.9ms | 7.69 GB | +217 MB | 44.1% |
| 41 | **HM_S5_Lymphoma_B_Symptoms_5** | 1097.4ms | 2102.6ms | 34830.9ms | 7.67 GB | +191 MB | 43.8% |
| 42 | **HM_S6_Warfarin_Review_6** | 1097.4ms | 2102.6ms | 307760.0ms | 7.67 GB | +194 MB | 43.9% |
| 43 | **RH_S1_Early_RA_1** | 1097.4ms | 2102.6ms | 25301.0ms | 7.70 GB | +225 MB | 44.2% |
| 44 | **RH_S2_SLE_2** | 1097.4ms | 2102.6ms | 25489.8ms | 7.67 GB | +194 MB | 43.9% |
| 45 | **RH_S3_Axial_Spondyloarthritis_3** | 1097.4ms | 2102.6ms | 31587.7ms | 7.66 GB | +180 MB | 43.7% |
| 46 | **RH_S4_Gout_4** | 1097.4ms | 2102.6ms | 12050.0ms | 7.65 GB | +171 MB | 43.7% |
| 47 | **RH_S5_Knee_Osteoarthritis_5** | 1097.4ms | 2102.6ms | 27951.2ms | 7.63 GB | +158 MB | 43.5% |
| 48 | **RH_S6_Psoriatic_Arthritis_6** | 1097.4ms | 2102.6ms | 20988.2ms | 7.63 GB | +156 MB | 43.5% |

## Generated Clinical Notes (Sample Section)

### Row #1: George_Varghese_1

*(No note content retrieved)*

### Row #2: Bindu_2

```markdown
## Presenting Complaints
1. Finding of a 4 millimeter polyp in the gallbladder noted on school checkup ultrasound.

## Past History
- Onset: Not specified for current complaint.
- Duration: Not specified.
- Progression: Static.
- Aggravating or relieving factors: Not discussed.
- Associated positive symptoms: None reported today.
- Associated negative symptoms: No history of abdominal pain, nausea, vomiting, fever, jaundice, or change in bowel habits reported.

## Family History
Not discussed

## Drug History
Not discussed

## Hospital Admissions
Not discussed

## General Examination & Vitals
General examination revealed abdomen soft with no tenderness. Murphy sign was negative. Liver and spleen were not palpable. Vital signs recorded: Blood pressure 118 by 76 mmHg, pulse 72 per minute, temperature 98.2 degree Fahrenheit, respiratory rate 16 per minute, oxygen saturation 99 percent. Weight 62 kg.

## Previous Diagnosis
- Asymptomatic gallbladder polyp (4 millimeter).

## Reports
- Ultrasound showed a 4 millimeter polyp in the fundus with no shadowing.
- Gallbladder wall was thin.
- Common bile duct was normal.

## Current Diagnosis
Asymptomatic gallbladder polyp, 4 millimeter.

## Plan of Care
- Investigations & Procedures Ordered: Review ultrasound after six months to check if the 4 millimeter polyp remains stable or increases in size.
- Dietary & Lifestyle Advice: Patient advised to increase intake of vegetables and fiber. Advised to reduce excessive fat intake. Advised to avoid heavy meals if abdominal pain occurs. Advised not to fast at home as there is no current pain.
- Patient Education & Red Flag Warnings: Patient instructed that if unbearable right-sided pain, fever, or yellow discoloration of the eyes occur, they should come to the casualty immediately and not wait six months. Patient advised to check jaundice in daylight. Review after 6 weeks with a new ultrasound report; discuss further if the size increases towards 10 millimeter.
- Medications Prescribed: No medications prescribed today.
```

### Row #3: Arun_Kumar_3

*(No note content retrieved)*

### Row #4: Type2_Diabetes_Male_54_1

```markdown
## Presenting Complaints
1. Increased thirst for three weeks.
2. Frequent urination, waking up three or four times at night.
3. Edema in both legs for one month.
4. Fatigue when climbing stairs.

## Past History
- Hypertension for five years.
- High cholesterol for three years.
- Appendectomy at age 24.
- Acute gastroenteritis two years ago, requiring a three-day hospital stay and drip treatment.

## Family History
- Father had Type 2 Diabetes.
- Mother has hypertension and osteoarthritis.

## Drug History
- Telmisartan 40 mg once daily (prior medication).
- Atorvastatin 10 mg once daily at bedtime (prior medication).

## Hospital Admissions
- Three days in Taluk hospital for acute gastroenteritis two years ago.

## General Examination & Vitals
General examination revealed slight pallor and pitting edema up to mid shin in both legs. Heart was normal with no murmur. Lungs were clear. Abdomen was soft, liver and spleen non-palpable. Peripheral pulses were palpable and pedal sensation was safe. Blood pressure measured 142 by 90 mmHg, pulse rate 82 per minute, temperature 98.4 degree Fahrenheit, respiratory rate 18 per minute, oxygen saturation 98 percent, weight 78 kg, BMI 28.2.

## Previous Diagnosis
- Stage 1 essential hypertension (as determined by current findings).

## Reports
- Random blood sugar was 284 mg per dL.
- ECG from six months ago was normal.

## Current Diagnosis
Type 2 Diabetes Mellitus with osmotic symptoms, Stage 1 Essential Hypertension, Dyslipidemia, and bilateral leg edema. Early diabetic nephropathy is a possibility, though not confirmed due to urine albumin being negative.

## Plan of Care
Medications Prescribed: Metformin 500 mg twice daily with meals for 14 days. Glimepiride 1 mg once daily 15 minutes before breakfast. Telmisartan 80 mg once daily in the morning after food. Atorvastatin 10 mg once daily at bedtime as before.
Investigations & Procedures Ordered: Fasting blood sugar, postprandial blood sugar, HbA1c, kidney test, electrolytes, urine albumin to creatinine ratio to be done on day seven. Dilated fundus examination scheduled in the eye department.
Dietary & Lifestyle Advice: Avoid sugar, sweets, refined flour, and fried foods. Increase vegetable intake. Walk for 30 minutes daily. Wash feet with cool water and dry them. Do not walk barefoot.
Patient Education & Red Flag Warnings: Patient was instructed to drink water if experiencing dizziness, sweating, or headache due to sugar fluctuations. To come back on the seventh day with reports to decide whether to continue Metformin based on results.
```

### Row #5: Dyspepsia_Male_38_2

```markdown
## Presenting Complaints
1. Epigastric pain and bloating for one week, started after consuming spicy biryani and fried meat.

## Past History
- Onset: Gradual, starting after eating spicy food (biryani and fried meat) last week.
- Duration: One week.
- Progression: Static.
- Aggravating or relieving factors: Pain is related to food intake. No specific relieving factors mentioned.
- Associated positive symptoms: None reported (no nausea, fever, black stools).
- Associated negative symptoms: Denied nausea, fever, black stools, weight loss, change in bowel habits.

## Family History
Not discussed

## Drug History
Not discussed

## Hospital Admissions
Not discussed

## General Examination & Vitals
General examination revealed soft abdomen with slight tenderness below the chest. Bowel sounds were normal. Vital signs recorded: Blood pressure 120 by 78 mmHg, Pulse 76 per minute, Temperature 98.4 degree Fahrenheit, Respiratory rate 16 per minute, Oxygen saturation 99 percent. Weight 70 kg.

## Previous Diagnosis
Not discussed

## Reports
- H. pylori test result not available (as of consultation).

## Current Diagnosis
Acute gastritis; non-ulcer dyspepsia secondary to spicy food intake.

## Plan of Care
Medications Prescribed: Omeprazole 20 mg once daily in the morning before food for 7 days. Gelusil 10 ml for pain when it occurs after meals.
Investigations & Procedures Ordered: H. pylori test may be done if symptoms persist after 7 days of Omeprazole therapy.
Dietary & Lifestyle Advice: Patient advised to avoid fried and very spicy foods this week. Advised to eat dinner early and not lie down immediately after eating. Advised to reduce tea, coffee, and cola intake. Patient was instructed that severe abdominal pain, black tarry stools, or hematemesis require immediate casualty evaluation.
Patient Education & Red Flag Warnings: Patient advised to return to OPD if discomfort persists after 7 days of Omeprazole therapy. If symptoms persist, H. pylori testing may be performed then.
```

*(... 43 more notes saved individually in `summaries/` directory)*

