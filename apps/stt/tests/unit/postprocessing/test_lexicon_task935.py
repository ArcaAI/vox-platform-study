"""TASK-935 (R-2, OD-2 a) — the clinical-vocabulary correction stage.

The served fine-tune hears "ceftriaxone" as "septrioxone" live and
"sephotrioxone" offline (TASK-934 §2.2), and prompt biasing does not reach a
token sequence the weights never learned. This stage is the deterministic
second consumer of the SAME hotwords list (OD-5 a): a transcribed token is
snapped to a CONFIGURED term when the two agree phonetically AND differ by no
more than a bounded share of their characters. Nothing else is ever touched —
a word the tenant did not name cannot be rewritten by this stage.

Every case below is a rule of that contract, not an example of it.
"""

from __future__ import annotations

import time

import pytest

from stt.postprocessing.lexicon import Correction, LexiconCorrector

CEFTRIAXONE = ("ceftriaxone",)


def _correct(text: str, terms: tuple[str, ...] = CEFTRIAXONE, **kwargs: object) -> str:
    return LexiconCorrector(terms, **kwargs).correct(text)[0]  # type: ignore[arg-type]


class TestTheCeftriaxoneMiss:
    """The two spellings the served model actually produces (TASK-934 §2.2)."""

    def test_the_live_mishearing_is_corrected(self) -> None:
        assert _correct("septrioxone") == "ceftriaxone"

    def test_the_offline_mishearing_is_corrected(self) -> None:
        assert _correct("sephotrioxone") == "ceftriaxone"

    def test_the_correction_leaves_its_neighbours_alone(self) -> None:
        assert _correct("intravenous septrioxone and") == "intravenous ceftriaxone and"

    def test_the_correction_reports_what_it_changed(self) -> None:
        text, corrections = LexiconCorrector(CEFTRIAXONE).correct("intravenous septrioxone and")
        assert text == "intravenous ceftriaxone and"
        assert len(corrections) == 1
        one = corrections[0]
        assert isinstance(one, Correction)
        assert (one.original, one.replacement) == ("septrioxone", "ceftriaxone")
        assert one.span == (1, 2)
        assert 0.0 < one.score <= 0.34


class TestTheBound:
    """A bounded stage: what it may NOT change is the load-bearing half."""

    def test_a_real_word_is_not_snapped_to_a_distant_term(self) -> None:
        # "oxygen" is phonetically near "oxycodone" and must survive it anyway —
        # the grapheme bound (0.556) is what refuses it.
        assert _correct("supplemental oxygen", terms=("oxycodone",)) == "supplemental oxygen"

    def test_a_term_absent_from_the_config_changes_nothing(self) -> None:
        assert (
            _correct("treated with septrioxone", terms=("metformin",)) == "treated with septrioxone"
        )

    def test_an_empty_term_list_is_a_no_op(self) -> None:
        assert _correct("treated with septrioxone", terms=()) == "treated with septrioxone"

    def test_a_configured_term_is_never_rewritten_into_another(self) -> None:
        # "oxycodone" IS a configured term; a sibling term must not consume it.
        text = _correct("oxycodone", terms=("oxycodone", "oxycontin"))
        assert text == "oxycodone"

    def test_short_tokens_are_never_touched(self) -> None:
        assert _correct("the cef and", terms=("cefa",)) == "the cef and"

    def test_the_token_count_is_preserved(self) -> None:
        before = "treated with intravenous septrioxone for five days"
        after = _correct(before)
        assert len(after.split()) == len(before.split())


class TestSurfaceForm:
    """Casing and punctuation belong to the sentence, not to the term."""

    def test_capitalisation_and_trailing_punctuation_survive(self) -> None:
        assert _correct("Septrioxone, daily.") == "Ceftriaxone, daily."

    def test_an_all_caps_token_stays_all_caps(self) -> None:
        assert _correct("SEPTRIOXONE") == "CEFTRIAXONE"

    def test_a_sentence_final_period_survives(self) -> None:
        assert _correct("Treated with septrioxone.") == "Treated with ceftriaxone."


class TestPhrases:
    """A configured term may be a phrase; then a phrase replaces a phrase."""

    def test_a_two_word_term_corrects_a_two_word_span(self) -> None:
        text = _correct("comunity aquired pneumonia", terms=("community acquired",))
        assert text == "community acquired pneumonia"

    def test_a_phrase_correction_reports_its_whole_span(self) -> None:
        _, corrections = LexiconCorrector(("community acquired",)).correct(
            "comunity aquired pneumonia"
        )
        assert len(corrections) == 1
        assert corrections[0].span == (0, 2)
        assert corrections[0].original == "comunity aquired"


class TestBounds:
    """Bounded by construction — a lexicon is an enhancement, never a gate."""

    def test_at_most_256_terms_are_kept(self) -> None:
        corrector = LexiconCorrector([f"term{i:04d}aaaa" for i in range(300)])
        assert len(corrector.terms) == 256

    def test_an_over_long_term_is_dropped(self) -> None:
        corrector = LexiconCorrector(["ceftriaxone", "x" * 65])
        assert corrector.terms == ("ceftriaxone",)

    def test_max_distance_is_configurable_and_narrows_the_stage(self) -> None:
        assert _correct("septrioxone", max_distance=0.1) == "septrioxone"

    def test_a_partial_sized_hypothesis_corrects_within_the_latency_budget(self) -> None:
        """200 tokens × 256 terms is the worst partial this stage can be handed.

        The list below is deliberately DEGENERATE — 255 terms that share a single
        phonetic key, so the key index cannot separate them and every one is
        scored the slow way. Measured on the development Mac: 10.6 ms here, 2.0 ms
        on a realistic formulary of the same size, microseconds on the six-term
        list the served model row actually carries. The assertion is generous
        because a shared CI box is not a benchmark; it exists to catch an
        algorithmic regression (the pre-memo build cost 798 ms), not to certify a
        number.
        """
        terms = ["ceftriaxone"] + [f"clinicalterm{i:03d}" for i in range(255)]
        corrector = LexiconCorrector(terms)
        text = " ".join(["intravenous septrioxone administered daily"] * 50)
        assert len(text.split()) == 200
        corrector.correct(text)  # warm the caches the timing must not include
        started = time.perf_counter()
        for _ in range(5):
            corrector.correct(text)
        elapsed_ms = (time.perf_counter() - started) * 1000 / 5
        assert elapsed_ms < 50.0, f"{elapsed_ms:.2f} ms per 200-token partial"


class TestIdempotence:
    def test_correcting_corrected_text_changes_nothing(self) -> None:
        once, first = LexiconCorrector(CEFTRIAXONE).correct("intravenous septrioxone")
        twice, second = LexiconCorrector(CEFTRIAXONE).correct(once)
        assert twice == once
        assert first and not second

    @pytest.mark.parametrize("text", ["", "   ", "123 456"])
    def test_degenerate_input_is_returned_unchanged(self, text: str) -> None:
        assert _correct(text) == text


class TestCodeSwitchedText:
    """The platform's ASR is Malayalam-English; the stage must be safe in both.

    The phonetic key is a Latin consonant skeleton, so a Malayalam word produces an
    EMPTY key — and an empty key never agrees with anything, on either side. The
    stage is therefore a deliberate no-op on Malayalam rather than an edit-distance
    free-for-all in a script it cannot hear. Recorded here as a known property: a
    Malayalam term in the hotword list will bias the decoder (TASK-934) but will not
    be corrected after it.
    """

    def test_a_malayalam_hypothesis_is_never_rewritten(self) -> None:
        corrector = LexiconCorrector(["രോഗിയുടെ"])
        text, corrections = corrector.correct("രോഗിക്ക് പനി ഉണ്ട്")
        assert text == "രോഗിക്ക് പനി ഉണ്ട്"
        assert corrections == []

    def test_a_code_switched_line_corrects_only_the_latin_token(self) -> None:
        text, corrections = LexiconCorrector(CEFTRIAXONE).correct("രോഗിക്ക് septrioxone നൽകി")
        assert text == "രോഗിക്ക് ceftriaxone നൽകി"
        assert [c.original for c in corrections] == ["septrioxone"]
