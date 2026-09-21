# hope-gpu-process-exporter — per-process GPU memory for Prometheus.
#
# `nvidia-smi` is NOT installed here. It is injected at runtime by the NVIDIA
# container toolkit (CDI), the same way it reaches every other GPU workload on
# this cluster, which is why this stays a plain slim-python image with no CUDA
# base and no vendor libraries baked in. The pod must therefore carry
# `runtimeClassName: nvidia`, `NVIDIA_VISIBLE_DEVICES=all` and
# `NVIDIA_DRIVER_CAPABILITIES=utility` — see README.md.
#
# The exporter uses only the Python standard library, so there is nothing to
# install and no lockfile to keep in step.
FROM python:3.12-slim-bookworm

# /proc/<pid>/cgroup is world-readable, so pod attribution needs no privilege.
# Run unprivileged; the only elevated thing this pod needs is `hostPID: true`.
RUN useradd --system --uid 65532 --no-create-home --shell /usr/sbin/nologin exporter

COPY exporter.py /usr/local/bin/gpu-process-exporter
RUN chmod 0555 /usr/local/bin/gpu-process-exporter

USER 65532
EXPOSE 9401

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:9401/metrics',timeout=4)" || exit 1

ENTRYPOINT ["python3", "/usr/local/bin/gpu-process-exporter"]
