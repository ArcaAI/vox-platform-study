"""Export guardrail's governed policy keys to the committed contract artifact (TASK-1050 §11.3 A).

    ~/miniconda3/envs/arcaenv/bin/python apps/guardrail/scripts/export_policy_keys.py         # write
    ~/miniconda3/envs/arcaenv/bin/python apps/guardrail/scripts/export_policy_keys.py --check # exit 1 on drift

`core/policy.py` `_SPECS` is the ONE source; `apps/guardrail/src/guardrail/tests/contracts/
policy-keys.json` is generated from it (`policy_key_catalogue()`), and the gateway validates
platform writes against that file without restating it. `test_task1050_judge_policy_keys.py`
fails when the two drift.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_APP / "src"))

from guardrail.core.policy import policy_key_catalogue  # noqa: E402

TARGET = _APP / "src" / "guardrail" / "tests" / "contracts" / "policy-keys.json"


def render() -> str:
    return json.dumps(policy_key_catalogue(), indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when the committed file drifts")
    args = parser.parse_args(argv)
    rendered = render()
    if args.check:
        current = TARGET.read_text(encoding="utf-8") if TARGET.exists() else ""
        if current != rendered:
            print(f"{TARGET} drifted from core/policy.py _SPECS — rerun without --check")
            return 1
        print(f"{TARGET} is up to date")
        return 0
    TARGET.write_text(rendered, encoding="utf-8")
    print(f"wrote {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
