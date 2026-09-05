"""TASK-881 — the CI eval gate's judge selection reads `AiRoutingPolicy`, not the retired
`AiTaskDefault` table (dropped by the wave-3a migration). String-level and hermetic on purpose:
the query runs against a live database only in the gate itself."""

from harness.eval.judge import selection


def test_the_judge_selection_reads_the_routing_policy_default_row() -> None:
    sql = selection._SELECT_SQL
    assert 'core."AiRoutingPolicy"' in sql
    assert '"isDefault"' in sql and "'ACTIVE'" in sql
    assert "AiTaskDefault" not in sql


def test_nothing_in_the_eval_package_names_the_retired_table() -> None:
    import pathlib

    root = pathlib.Path(selection.__file__).resolve().parents[1]
    offenders = [
        str(f.relative_to(root))
        for f in root.rglob("*.py")
        if "AiTaskDefault" in f.read_text() and not f.name.startswith("test_")
    ]
    assert offenders == [], offenders
