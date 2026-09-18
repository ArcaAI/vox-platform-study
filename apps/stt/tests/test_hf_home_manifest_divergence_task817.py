"""(F-3) — the image's HF cache env is overridden in the cluster; say so.

`apps/stt/docker/Dockerfile` sets ``HF_HOME=/models/hf-cache``. The deployed
Deployment (`arca/hope-v2-deployment`, `deployment/k8s/base/stt.yaml`) sets
something else entirely, and host env beats image env
(`00-project-context.md` §Precedence), so the image's value is INERT in every
deployed environment.

Both values are individually defensible — `/models` is created and chowned to
`hope` in the image, so the image default works standalone; the manifest path is
where the weights actually are. What is NOT defensible is the image asserting one
path while the cluster uses another with nothing connecting them: an engineer
debugging a cache miss reads the Dockerfile, goes to `/models/hf-cache`, finds it
empty, and concludes the cache is broken.

Two remedies were available — change the image value, or document the divergence.
Documenting is the one that changes no runtime behaviour: editing the value is a
no-op in the cluster (the manifest wins regardless) but silently repoints every
non-cluster consumer of this image. So this test pins the DOCUMENTATION, and it
pins the specific facts a reader needs: the real paths.

WHAT TASK-985 M-60 CORRECTED, AND WHY IT MATTERED

Until 2026-09-19 this test pinned ``/home/hope/.cache/huggingface`` — a node-local
`models-cache` hostPath that TASK-855 RETIRED. Weights now come from the MinIO
bucket `s3://hope-models`, mounted read-only at `/mnt/models-bucket` by a native
s3fs sidecar, and the manifest points the HF cache there. The test kept passing
the whole time, because it compared one stale artifact (the Dockerfile comment)
against another stale artifact (the constant below) and they agreed with each
other. Agreement between two copies of the same wrong answer is not coverage.

So the assertions now run in both directions: the live values must be PRESENT and
the retired path must be ABSENT. Reinstating the old text fails the test instead
of satisfying it.

If the manifest ever drops these overrides, delete this test along with the
comment it guards — at that point the image value IS the effective value and
there is no divergence left to explain.
"""

from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parents[1] / "docker" / "Dockerfile"

#: What `deployment/k8s/base/stt.yaml` actually applies (verified 2026-09-19).
MANIFEST_HF_HOME = "/mnt/models-bucket/hf"

#: The variable apps/stt ACTUALLY reads — `Settings.huggingface_cache_dir`. Its
#: value is one directory BELOW HF_HOME, and it is passed to `snapshot_download`
#: as an explicit `cache_dir=`, which makes HF_HUB_CACHE inert. Getting this wrong
#: is a guaranteed miss, and a fatal one under HF_HUB_OFFLINE=1.
MANIFEST_HUB_DIR = "/mnt/models-bucket/hf/hub"

#: The image bakes HF_HOME onto a WRITABLE path, so without this the fallback on a
#: missing weight is a silent download attempt into an ephemeral cache rather than
#: a named failure. It is part of the same contract and belongs in the same note.
MANIFEST_OFFLINE_FLAG = "HF_HUB_OFFLINE"

#: The node-local hostPath cache retired by TASK-855. Nothing mounts it and
#: nothing reads it; a Dockerfile that still names it is describing a dead world.
RETIRED_HOSTPATH_CACHE = "/home/hope/.cache/huggingface"


def _dockerfile() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def test_hf_home_divergence_from_the_manifest_is_documented() -> None:
    text = _dockerfile()

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


def test_the_variable_stt_actually_reads_is_named() -> None:
    text = _dockerfile()

    assert "HUGGINGFACE_CACHE_DIR" in text and MANIFEST_HUB_DIR in text, (
        "the note must name HUGGINGFACE_CACHE_DIR and its value "
        f"{MANIFEST_HUB_DIR}. HF_HOME alone is not the whole contract: "
        "`Settings.huggingface_cache_dir` is what the loader passes to "
        "snapshot_download, and it points one directory deeper than HF_HOME."
    )

    assert MANIFEST_OFFLINE_FLAG in text, (
        f"the note must mention {MANIFEST_OFFLINE_FLAG}. The image's own HF_HOME is "
        "a writable path, so that flag is the only thing turning a missing weight "
        "into a named failure instead of a silent download."
    )


def test_the_retired_hostpath_cache_is_not_described_as_live() -> None:
    """The half that makes this test capable of failing.

    The previous version REQUIRED this path, so the Dockerfile and the test could
    drift together indefinitely. Requiring its absence is what turns the pair into
    a check rather than a mirror.
    """
    text = _dockerfile()

    assert RETIRED_HOSTPATH_CACHE not in text, (
        f"apps/stt/docker/Dockerfile still names {RETIRED_HOSTPATH_CACHE}, the "
        "node-local hostPath cache retired by TASK-855. Weights come from the "
        f"s3fs-mounted bucket at {MANIFEST_HF_HOME} now; describing the old mount "
        "sends a reader to a path that does not exist in any environment."
    )
