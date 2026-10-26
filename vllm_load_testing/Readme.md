- Ensure that the nvida HPC toolkit and runtime is installed and where vLLM can find them.
  In my local machine it is at /opt/nvidia/hpc_sdk/Linux_x86_64
- Set the following paths (bashrc) 
  - export CUDA_HOME=/opt/nvidia/hpc_sdk/Linux_x86_64/24.9/cuda
  - export PATH=/opt/nvidia/hpc_sdk/Linux_x86_64/24.9/compilers/bin:$PATH
  - export PATH=$CUDA_HOME/bin:$PATH

- Export the LD library path (bashrc):
export LD_LIBRARY_PATH=/opt/nvidia/hpc_sdk/Linux_x86_64/24.9/cuda/12.6/targets/x86_64-linux/lib:$LD_LIBRARY_PATH


- In a dedicated python environment, install vllm and openai packages:
  pip install -U "vllm[audio]" openai

 - To run a vLLM server in a separate terminal instance and log its output, use: 
vllm serve openai/whisper-small --port 8000 2>&1 | tee logs/vllm_audio.log 

- [Verify] In a separate terminal, check if the model is served:
  curl http://localhost:8000/v1/models
  The result of this command should look like:

    {"object":"list","data":[{"id":"openai/whisper-small","object":"model","created":1789883169,"owned_by":"vllm","root":"openai/whisper-small","parent":null,"max_model_len":448,"permission":[{"id":"modelperm-aea3cc28b81ec4a6","object":"model_permission","created":1789883169,"allow_create_engine":false,"allow_sampling":true,"allow_logprobs":true,"allow_search_indices":false,"allow_view":true,"allow_fine_tuning":false,"organization":"*","group":null,"is_blocking":false}]}]}

- Git clone the repo into a folder named vLLM_test

- Place all the test audio files in test_files/  and create a logs/ folder to store the output logs. 

- In a separate terminal instance Start Nvidia Gpu monitoring service using:
nvidia-smi --query-gpu=timestamp,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw --format=csv -lms 200 > logs/gpu.csv

  - [Note]: the -lms must be adjusted based on the load so that the sampling does not miss the gpu work load.
  - [Note]: this command should produce a gpu.csv file with entries depicting the gpu activity

- In a separate terminal instance, execute the python process  
python3 main.py 

  - [Note]: this must produce a sample output:
 
   Concurrency=1,Avg Latency=0.56s
   Concurrency=2,Avg Latency=0.70s

- Three key outputs expected:
  - logs/vllm_audio.log showing the vllm server instantiation logs
  - logs/gpu.csv showing the gpu usage
  - The Concurrency, Avg Latency std out