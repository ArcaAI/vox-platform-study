"""(F-3) — the image's HF_HOME is overridden in the cluster; say so.

`apps/stt/docker/Dockerfile` sets ``HF_HOME=/models/hf-cache``. The deployed
Deployment (`arca/hope-v2-deployment`, `deployment/k8s/base/stt.yaml`, verified
2026-08-28) sets it to something else entirely::

    - name: HOME
      value: /home/hope
    - name: HF_HOME
      value: /home/hope/.cache/huggingface
    - name: HUGGINGFACE_CACHE_DIR
      value: /home/hope/.cache/huggingface/hub
    volumeMounts:
      - name: models-cache
        mountPath: /home/hope/.cache/huggingface/hub

Host env beats image env (`00-project-context.md` §Precedence), so the image's
value is INERT in every deployed environment. The `dev` overlay does not patch
it, so base is what runs.

Both values are individually defensible — `/models` is created and chowned to
`hope` in the image, so the image default works standalone; the manifest path is
where the persistent `models-cache` hostPath is actually mounted. What is NOT
defensible is the image asserting one path while the cluster uses another with
nothing connecting them: an engineer debugging a cache miss reads the Dockerfile,
goes to `/models/hf-cache`, finds it empty, and concludes the cache is broken.

offers two remedies — change the image value, or document the
divergence. Documenting is the one that changes no runtime behaviour: editing
the value is a no-op in the cluster (the manifest wins regardless) but silently
repoints every non-cluster consumer of this image. So this test pins the
DOCUMENTATION, and it pins the specific fact a reader needs: the real path.

If the manifest is ever changed to drop its `HF_HOME` override, this test should
be deleted along with the comment — at that point the image value IS the
effective value and there is no divergence left to explain.
"""

from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parents[1] / "docker" / "Dockerfile"

#: What `deployment/k8s/base/stt.yaml` actually applies.
MANIFEST_HF_HOME = "/home/hope/.cache/huggingface"


def test_hf_home_divergence_from_the_manifest_is_documented() -> None:
    text = DOCKERFILE.read_text(encoding="utf-8")

    assert "HF_HOME=" in text, (
        "apps/stt/docker/Dockerfile no longer sets HF_HOME — if that is deliberate, "
        "delete this test and the comment it guards."
    )

    assert MANIFEST_HF_HOME in text, (
        "apps/stt/docker/Dockerfile sets HF_HOME but never mentions "
        f"{MANIFEST_HF_HOME}, the value the Deployment actually applies. Host env "
        "beats image env, so the image value is inert in the cluster; a reader "
        "debugging a cache miss is sent to a path nothing writes to."
    )
