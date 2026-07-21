"""Retrieval-eval tests (verification).

Locks the deterministic synthetic retrieval-eval numbers so the Phase-3
retrieval exit-gate signal ("% claims with a valid citation; basic recall
sanity") stays reproducible in CI. The eval ingests the synthetic corpus into a
real in-memory Qdrant engine with the real fastembed BM25 sparse embedder and
runs the real ``HybridRetriever`` (dense + reranker stubbed — the BAAI/bge-m3 +
TEI models are the documented prerequisite handoff).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from harness.eval.retrieval_eval import (
    _DEFAULT_FIXTURE,
    aggregate,
    chunk_point_id,
    load_fixture,
    run_eval,
)


def test_default_fixture_exists_and_has_a_cross_tenant_distractor():
    fixture = load_fixture(_DEFAULT_FIXTURE)
    assert fixture["version"] == "retrieval_synthetic_v0"
    assert fixture["queries"], "fixture must define queries"
    tenants = {c["tenant_id"] for c in fixture["corpus"]}
    assert "tenant-other" in tenants, "fixture must include a cross-tenant distractor chunk"


def test_point_id_is_deterministic():
    a = chunk_point_id("t", "doc", 0)
    b = chunk_point_id("t", "doc", 0)
    c = chunk_point_id("t", "doc", 1)
    assert a == b and a != c


@pytest.mark.asyncio
async def test_synthetic_eval_is_perfect_recall_and_no_leak():
    fixture = load_fixture(_DEFAULT_FIXTURE)
    report = await run_eval(fixture, top_k_rerank=5)
    agg = report["aggregate"]

    # The synthetic corpus is lexically separable, so the BM25 + RRF channel
    # alone recalls every gold chunk and forms a valid citation each time.
    assert agg["n_queries"] == len(fixture["queries"])
    assert agg["recall_at_k_mean"] == 1.0
    assert agg["hit_at_k_rate"] == 1.0
    assert agg["mrr"] == 1.0
    assert agg["citation_validity_rate"] == 1.0
    # The cross-tenant sepsis distractor (overlapping vocabulary, different tenant)
    # is NEVER retrieved — tenant isolation holds under the real Qdrant filter.
    assert agg["cross_tenant_leaks"] == 0


@pytest.mark.asyncio
async def test_every_query_top_citation_is_valid_and_tenant_clean():
    fixture = load_fixture(_DEFAULT_FIXTURE)
    report = await run_eval(fixture, top_k_rerank=5)
    for q in report["queries"]:
        assert q["top_citation_valid"] is True, f"{q['query']} produced no valid citation"
        assert q["cross_tenant_leak"] == 0, f"{q['query']} leaked a cross-tenant chunk"
        assert q["hit_at_k"] is True


def test_aggregate_empty_is_safe():
    assert aggregate([]) == {"n_queries": 0}


def test_default_fixture_path_resolves():
    assert Path(_DEFAULT_FIXTURE).is_file()
