"""Upload the three lab models into the OrbStack MinIO bucket `hope-models`.

Layout mirrors production: <slug>/<version>/<files, flat>.
Run with `kubectl -n hope-lab port-forward svc/minio 19000:9000` active.
"""

import os
import sys
from pathlib import Path

from minio import Minio

ROOT = Path(__file__).parent / "models"
BUCKET = "hope-models"

# (local dir, bucket prefix, filename filter)
PLAN = [
    (ROOT / "medical-ner", "medical-ner/v1", lambda p: ".cache" not in p.parts),
    (
        ROOT / "qwen3-0.6b-gguf",
        "qwen3-0.6b-gguf/v1",
        lambda p: ".cache" not in p.parts and "q4_k_s" in p.name.lower(),
    ),
    (
        ROOT / "whisper-medical-gguf",
        "whisper-medical-gguf/v1",
        lambda p: ".cache" not in p.parts and "q5_0" in p.name.lower(),
    ),
]


def main() -> int:
    client = Minio(
        "localhost:19000",
        access_key=os.environ.get("MINIO_USER", "labadmin"),
        secret_key=os.environ.get("MINIO_PASS", "labadmin12345"),
        secure=False,
    )
    if not client.bucket_exists(BUCKET):
        client.make_bucket(BUCKET)
        print(f"created bucket {BUCKET}")

    total = 0
    for local, prefix, keep in PLAN:
        if not local.exists():
            print(f"SKIP {local.name}: not downloaded")
            continue
        for path in sorted(local.rglob("*")):
            if not path.is_file() or not keep(path.relative_to(local)):
                continue
            key = f"{prefix}/{path.name}"  # FLAT, as production requires
            size = path.stat().st_size
            client.fput_object(BUCKET, key, str(path))
            total += size
            print(f"  {key:<62} {size/1e6:8.1f} MB")

    print(f"\nuploaded {total/1e6:.1f} MB")
    for obj in client.list_objects(BUCKET, recursive=True):
        print(f"  s3://{BUCKET}/{obj.object_name}  ({obj.size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
