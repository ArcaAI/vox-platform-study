"""TASK-985 (M-31) — the matcher's two wrong axes, and the one that was missing.

TASK-935 shipped the correction stage with two gates: "does this sound like a
configured term?" and "is it spelled close to one?". Both are answered YES by
ordinary English words and NO by the mishearing the clinician actually produced,
which is why the served configuration both rewrote ``creating`` into
``creatinine`` AND missed ``Atorvacetam`` for ``atorvastatin`` on the same run.

No single bound fixes both. Keeping "Atorvacetam" needs ``b >= 0.4167``; dropping
"creating" needs ``b < 0.30``. The tests below pin the two changes that do:

* a **vocabulary gate** — the axis neither original gate had — which refuses a
  window whose every token is an ordinary word, at any distance, on any path;
* a **graded relaxation**, replacing the binary switch on exact key equality
  that cost "Atorvacetam" all of its relaxation for one terminal nasal.

:data:`ORDINARY_WORDS` is the fixture that makes the first claim measurable
rather than anecdotal: 1100+ general and clinical English words, swept against
the term list the served model row actually carries. It is a stand-in for the
versioned language asset ST-7 delivers, and it is committed because a gate whose
completeness is never measured is a gate nobody can trust.

Every case below is a rule of the contract, not an example of it.
"""

from __future__ import annotations

import pytest

from stt.postprocessing.lexicon import (
    DEFAULT_MAX_DISTANCE,
    EXACT_KEY_GRAPHEME_CEILING,
    REJECTION_REASONS,
    STAGES,
    TOKENS_SCANNED,
    LexiconCorrector,
    phonetic_keys,
)

#: The hotword list the served ASR row carries (`seed/ai-models/audio.ts`). Every
#: sweep below runs against THIS list, because a precision claim about some other
#: list is a claim about nothing.
SERVED_TERMS: tuple[str, ...] = (
    "ceftriaxone",
    "amoxicillin",
    "piperacillin-tazobactam",
    "vancomycin",
    "ceftazidime",
    "azithromycin",
    "metronidazole",
    "troponin",
    "creatinine",
    "metformin",
    "lisinopril",
    "atorvastatin",
    "bisoprolol",
    "apixaban",
    "furosemide",
    "levothyroxine",
    "salbutamol",
    "prednisolone",
    "amlodipine",
    "omeprazole",
)

#: General + clinical English that is NOT a drug name. A stand-in for the
#: versioned protected-vocabulary asset (ST-7): sized for the job, not for
#: completeness. Sorted, lower-case, alphabetic only — the gate is a membership
#: test over folded surface forms, so the fixture holds folded surface forms.
_ORDINARY = """
about above accept according account across action activity actually address
admission advice after again against agree airway alcohol allergies allergy
almost alone along already also although always among amount analysis another
answer anxiety anyone anything appear appetite application appointment approach
area argue around arrive article artery arthritis ask aspirin assessment assist
attack attend attention available avoid awake aware away baby back bacteria bad
balance because become bed been before begin behaviour behind being believe
below beside best better between beyond bilateral birth bleeding blood body bone
both bottle bowel breath breathing bring brother build burning business call
cancer cannot capacity capsule cardiac care carry case catch cause caution
cease centre certain chance change character charge chart check chest child
children choice cholesterol choose chronic circulation claim clean clear
clinic clinical close cold collapse colour come comfort common community
company complain complete complex concern condition confirm confusion consider
consistent constant consult contact continue contract control cough could
counsel count country couple course cover create created creates creating
creation creative creatine creator credit crisis critical current cycle daily
damage data daughter decide decrease deep defect degree delay deliver dementia
depend depression describe design despite detail develop diabetes diagnosis
diarrhoea diet difference different difficult discharge discomfort discuss
disease disorder distance district doctor document does dose double down draw
dressing drink drive drop drug dry during duty each ear early easy eating
economy edge education effect effort either elderly electric elevated else
emergency employee end energy enough enter entire environment episode equal
error especially essential establish evaluate even evening event ever every
evidence exact examination example except exchange excuse exercise exist expect
experience expert explain express extend extra eye face factor fail fairly
fall family fasting father fatigue fault fear feature feed feel fever few field
figure fill film final finance find fine finger finish fire first fish fit five
fixed floor flow fluid follow following food foot force forget form former
forward found four fracture free frequent fresh friend from front full function
fund further future gain game garden gas general get girl give glad glass
global goes going good govern grade great green ground group grow guard guess
guide hair half hand happen hard have head health hear heart heavy help here
high history hold home hope hospital hot hour house however huge human hundred
hurt husband idea identify ignore illness image imagine immediate impact
implement important improve include increase indeed independent indicate
individual industry infection inform initial injection injury inside insulin
insurance intake intend interest internal interview into introduce
investigation involve iron isomer isopropyl issue itch item itself join joint
judge just keep keratin key kidney kind know knowledge label labour lack
language large last late later laugh layer lead leaf learn least leave left leg
legal length less lesion let letter level library lie life lift light like
likely limb limit line liquid list listen little live liver living local locate
long look lose loss lot loud love low lower lung lysine machine main maintain
major make male manage many market mass match material matter may maybe meal
mean measure meat medical medicine meet member memory mention message metabolic
metabolism method middle might mild milk mind minute miss mixed model moment
money monitor month more morning most mother mouth move much muscle must nail
name nasal nation natural nausea near neck need negative neither nerve nervous
network never new news next night nine nitrate nitrogen noise none normal north
nose note nothing notice now nurse nutrition object observe obtain obvious
occur ocean odds off offer office often oil okay old omega once one onset only
onto open operate opinion opportunity oppose option oral order organ other
ought outcome output outside over overall owner oxygen pack page pain paper
parent part particular partner pass past path patient pattern pay peak people
per perform perhaps period person phase phone physical pick picture piece place
plan plant plasma plate play please plenty point policy poor popular position
positive possible post potassium practice prefer pregnancy prepare prescribe
present pressure pretty prevent previous price primary print prior private
problem procedure process produce product professional profile program progress
project promise proper propylene protect protein provide public pull pulse pump
purpose push put quality quarter question quick quiet quite radiation raise
range rapid rate rather reach react read ready real reason receive recent
recognise record recover recreation reduce refer reflect refuse regard region
regular relate release relevant relief remain remember remove renal repeat
replace report represent request require research resident resist resource
respect respiratory respond response rest result return review rhythm rich
right rise risk role room rough round routine rule run safe same sample save
say scale scan scene school science score screen search season seat second
secondary section secure see seem self sell send sense sensitive separate
series serious serve service session set seven several severe shape share
sharp sheet shift shock shoe shop short shoulder show shower sick side sign
significant similar simple since single sister sit site situation six size
skill skin sleep slight slow small smoke smooth social sodium soft software
solution solve some son soon sore sort sound source south space speak special
specific speech speed spend spine spirit spread spring stable staff stage stand
standard start state station status stay steady step stick still stock stomach
stone stop store story straight strange stream street strength stress stretch
strict strong structure student study stuff style subject substance success
such sudden suffer sugar suggest summary support suppose sure surface surgery
surprise survey survive suspect swallow sweat swelling swing switch symptom
system table take talk target task taste teach team technology tell temperature
ten tend tension term test than thank that the their them then theory therapy
there these they thick thin thing think third this those though thought
thousand three throat through throw thus time tired tissue title today together
toilet tone tonic tonight too tool tooth top total touch toward town trace
track trade traffic train transfer transport travel treat treatment tree trend
trial trip trouble true trust truth try tube turn twice two type typical ulcer
uncertain under understand unit unless until upon upper upset urgent urine use
useful user usual vaccine value variable various vein venous version very view
visible vision visit vital voice volume vomit vomiting vote wait wake walk wall
want ward warm warn wash waste watch water wave way weak wear week weight
welcome well west wet what wheeze when where whether which while white who
whole why wide wife will wind window wish with within without woman wonder word
work world worry worse would wound wrist write wrong year yes yesterday yet you
young your yourself zone
"""
ORDINARY_WORDS: tuple[str, ...] = tuple(sorted(set(_ORDINARY.split())))

#: The ordinary words the SERVED term list rewrites when the gate is not armed —
#: measured over :data:`ORDINARY_WORDS`, not chosen. Five are the false rewrites
#: this ticket set out to stop; "creatine" is the sixth and the worst of them,
#: because creatine and creatinine are different substances and a clinician
#: reading the note cannot tell the rewrite happened.
FALSE_REWRITES: frozenset[str] = frozenset(
    {"certain", "creatine", "creating", "creation", "creative", "isopropyl"}
)

#: The mishearing the model actually produces for a term on the served list, and
#: the one the shipped matcher missed. Reproduced live twice on
#: `medication_review_01` with the stage active and "atorvastatin" configured.
MISHEARINGS: tuple[tuple[str, str], ...] = (
    ("Atorvacetam", "atorvastatin"),
    ("septrioxone", "ceftriaxone"),
    ("sephotrioxone", "ceftriaxone"),
)


def _rewritten(corrector: LexiconCorrector, words: tuple[str, ...]) -> dict[str, str]:
    """Every word in *words* the corrector changes, mapped to what it became."""
    changed: dict[str, str] = {}
    for word in words:
        text, corrections = corrector.correct(word)
        if corrections:
            changed[word] = text
    return changed


class TestTheVocabularyGate:
    """The axis that was missing: is the candidate a word of the language?"""

    def test_the_served_term_list_rewrites_ordinary_words_without_it(self) -> None:
        """The defect, measured. This is the state of the served configuration.

        Six words out of 1100+ is a low RATE and an unacceptable KIND: every one
        of them turns a word a clinician said into a drug or a lab marker they
        did not.
        """
        unarmed = LexiconCorrector(SERVED_TERMS)
        assert set(_rewritten(unarmed, ORDINARY_WORDS)) == FALSE_REWRITES

    def test_the_gate_removes_every_one_of_them(self) -> None:
        armed = LexiconCorrector(SERVED_TERMS, protected_vocabulary=ORDINARY_WORDS)
        assert _rewritten(armed, ORDINARY_WORDS) == {}

    def test_the_gate_removes_them_in_running_prose_too(self) -> None:
        """Not just word by word: the whole corpus as one line, so every adjacent
        pair is also a candidate window for the merging path."""
        line = " ".join(ORDINARY_WORDS)
        armed = LexiconCorrector(SERVED_TERMS, protected_vocabulary=ORDINARY_WORDS)
        text, corrections = armed.correct(line)
        assert corrections == []
        assert text == line

    def test_the_sweep_is_not_a_tautology(self) -> None:
        """The mutation arm. Same corpus, same terms, gate off — non-empty.

        Without this, "0 rewrites over the words the gate contains" proves only
        that the gate was consulted.
        """
        unarmed = LexiconCorrector(SERVED_TERMS, protected_vocabulary=None)
        assert _rewritten(unarmed, ORDINARY_WORDS) != {}

    def test_a_word_outside_the_vocabulary_is_still_correctable(self) -> None:
        """The gate refuses known words; it does not require a word to be known.

        This is what keeps the gate from becoming a second, silent term list —
        and it is why the asset's COMPLETENESS is a measurement (the held-out
        sweep), not something this module can assert.
        """
        held_out = tuple(word for word in ORDINARY_WORDS if word != "creating")
        armed = LexiconCorrector(SERVED_TERMS, protected_vocabulary=held_out)
        assert armed.correct("creating")[0] == "creatinine"

    def test_a_phrase_is_refused_only_when_EVERY_token_is_a_word(self) -> None:
        """"comunity aquired" is half misheard, which is the case this stage is for."""
        armed = LexiconCorrector(
            ("community acquired",), protected_vocabulary=("community", "acquired", "and")
        )
        assert armed.correct("comunity aquired")[0] == "community acquired"
        assert armed.correct("community acquired")[0] == "community acquired"

    def test_the_gate_takes_any_membership_test_not_just_a_set(self) -> None:
        """The asset may be a frozenset, a mapping, or a memory-mapped index.

        The module asks one question and does not care how it is answered — which
        is the whole reason it can be delivered as a versioned artifact rather
        than as a literal in this file.
        """

        class EverythingIsAWord:
            def __contains__(self, word: str) -> bool:
                return True

        corrector = LexiconCorrector(SERVED_TERMS, protected_vocabulary=EverythingIsAWord())
        assert corrector.protected is True
        assert corrector.correct("septrioxone")[1] == []

    def test_a_list_is_materialised_and_folded(self) -> None:
        corrector = LexiconCorrector(SERVED_TERMS, protected_vocabulary=["Creating"])
        assert corrector.correct("creating")[1] == []

    def test_no_vocabulary_means_no_gate(self) -> None:
        assert LexiconCorrector(SERVED_TERMS).protected is False


class TestTheGradedRelaxation:
    """The binary switch on exact key equality is what lost the real mishearing."""

    def test_the_mishearing_the_binary_switch_missed_is_recovered(self) -> None:
        """"Atorvacetam" keys ATRFSTM against atorvastatin's ATRFSTN — one nasal.

        Under the binary switch that single edit cost ALL relaxation and the
        candidate fell to the strict path, where int(0.34 x 12) = 4 rejected its
        5 edits by one. This is the ticket's true positive.
        """
        corrector = LexiconCorrector(SERVED_TERMS)
        text, corrections = corrector.correct("Atorvacetam")
        assert text == "Atorvastatin"
        assert corrections[0].stage == "graded"
        assert corrections[0].score == pytest.approx(5 / 12)

    def test_the_binary_switch_is_what_missed_it(self) -> None:
        """The control arm: the same input, the same bounds, grading off."""
        binary = LexiconCorrector(SERVED_TERMS, graded_relaxation=False)
        assert binary.correct("Atorvacetam") == ("Atorvacetam", [])

    def test_both_designed_true_positives_still_correct(self) -> None:
        corrector = LexiconCorrector(SERVED_TERMS, protected_vocabulary=ORDINARY_WORDS)
        for heard, term in MISHEARINGS:
            assert corrector.correct(heard)[0].lower() == term

    def test_grading_admits_nothing_new_on_ordinary_english(self) -> None:
        """Why grading ships ON while the word gate waits for its asset.

        Same corpus, same terms, grading on vs off: the SAME six words. The
        relaxation is a smoothing of a cliff, not a widening of the envelope —
        the hard half-token ceiling is untouched, and the candidates grading
        admits are the ones the binary switch already handed 0.5 to whenever
        their keys happened to land exactly equal.
        """
        graded = LexiconCorrector(SERVED_TERMS, graded_relaxation=True)
        binary = LexiconCorrector(SERVED_TERMS, graded_relaxation=False)
        assert set(_rewritten(graded, ORDINARY_WORDS)) == set(
            _rewritten(binary, ORDINARY_WORDS)
        )

    def test_equal_keys_still_earn_the_full_relaxed_ceiling(self) -> None:
        """"sephotrioxone" is 0.385 away on characters and is recovered only
        because "PH" and "CEF" are the same sound (key SFTRKSN, exactly
        ceftriaxone's). Grading must not cost it anything."""
        _, corrections = LexiconCorrector(("ceftriaxone",)).correct("sephotrioxone")
        assert corrections[0].score == pytest.approx(5 / 13)
        assert corrections[0].score > DEFAULT_MAX_DISTANCE

    def test_the_bound_still_refuses_a_distant_real_word(self) -> None:
        """"oxygen" survives a configured "oxycodone" on the bound alone, at
        every ceiling the module can earn — the word gate is its second defence,
        not its only one."""
        for graded in (True, False):
            corrector = LexiconCorrector(("oxycodone",), graded_relaxation=graded)
            assert corrector.correct("supplemental oxygen")[1] == []

    def test_the_half_token_ceiling_is_never_exceeded(self) -> None:
        corrector = LexiconCorrector(SERVED_TERMS, max_distance=EXACT_KEY_GRAPHEME_CEILING)
        assert corrector.relaxed_max_distance == EXACT_KEY_GRAPHEME_CEILING
        for word in ORDINARY_WORDS:
            for correction in corrector.correct(word)[1]:
                assert correction.score <= EXACT_KEY_GRAPHEME_CEILING

    def test_the_relaxed_ceiling_is_never_below_the_strict_one(self) -> None:
        corrector = LexiconCorrector(SERVED_TERMS, 0.4, relaxed_max_distance=0.2)
        assert corrector.relaxed_max_distance >= corrector.max_distance

    def test_the_relaxed_ceiling_is_settable_for_calibration(self) -> None:
        """The strict x relaxed cross-product is a measurement, and it cannot be
        swept while the relaxed ceiling is derived as twice the strict one and
        then capped — every strict value in the sweep pins relaxed at 0.5."""
        narrow = LexiconCorrector(SERVED_TERMS, relaxed_max_distance=DEFAULT_MAX_DISTANCE)
        assert narrow.relaxed_max_distance == DEFAULT_MAX_DISTANCE
        assert narrow.correct("Atorvacetam") == ("Atorvacetam", [])


class TestThePhoneticKey:
    """The key decides which candidates are ever compared, so its bugs are silent."""

    @pytest.mark.parametrize(
        ("word", "expected"),
        [
            # A word-final C or G took the FRONT-VOWEL branch, because the letter
            # after it is "" and `"" in "EIY"` is True in Python — a substring
            # test, not set membership. Invisible on the two designed cases and
            # wrong for every word ending in C or G.
            ("creating", ("KRTNK", "KRTNK")),
            ("tonic", ("TNK", "TNK")),
            # The same hazard on the SI / TI lookahead: `"" in "OA"` is True, so a
            # word ending in -si or -ti keyed its sibilant as X.
            ("psi", ("PS", "PS")),
            # The designed cases, unchanged by the fix.
            ("ceftriaxone", ("SFTRKSN", "KFTRKSN")),
            ("septrioxone", ("SPTRKSN", "SPTRKSN")),
            ("sephotrioxone", ("SFTRKSN", "SFTRKSN")),
            # One terminal nasal apart, and the key never collapses M and N —
            # which is correct, and is why the relaxation had to become graded.
            ("atorvacetam", ("ATRFSTM", "ATRFKTM")),
            ("atorvastatin", ("ATRFSTN", "ATRFSTN")),
            ("creatinine", ("KRTN", "KRTN")),
        ],
    )
    def test_the_key_table(self, word: str, expected: tuple[str, str]) -> None:
        assert phonetic_keys(word) == expected

    def test_certain_reaches_creatinine_through_its_SECONDARY_key(self) -> None:
        """Recorded because it explains the worst false rewrite: "certain" carries
        KRTN as its alternate (C before a front vowel is S, with K as the
        secondary — the branch that exists to rescue "ceftriaxone"), which is
        creatinine's sole key. Equal keys, so it earns the full 0.5 ceiling, and
        only the word gate can refuse it."""
        assert phonetic_keys("certain")[1] == phonetic_keys("creatinine")[0]


class TestTheSpaceAgnosticPath:
    """Exact, so MIN_TOKEN_CHARS does not bind it and a script cannot betray it."""

    def test_a_split_term_is_rejoined(self) -> None:
        corrector = LexiconCorrector(("ceftriaxone",))
        text, corrections = corrector.correct("given cef tri axone daily")
        assert text == "given ceftriaxone daily"
        assert corrections[0].stage == "space_agnostic"
        assert corrections[0].score == 0.0
        assert corrections[0].span == (1, 4)

    def test_an_abbreviation_shorter_than_the_floor_is_reachable(self) -> None:
        """MIN_TOKEN_CHARS is right for a DISTANCE match — one edit on "bp" is
        half the token — and wrong for a match that has no distance at all."""
        corrector = LexiconCorrector(("BP",))
        assert corrector.correct("b.p.")[0] == "BP."
        assert corrector.correct("B P")[0] == "BP"

    def test_a_short_token_is_still_never_snapped_by_distance(self) -> None:
        assert LexiconCorrector(("BP",)).correct("pb") == ("pb", [])
        assert LexiconCorrector(("cefa",)).correct("the cef and") == ("the cef and", [])

    def test_tokens_merge_but_never_split(self) -> None:
        """A hypothesis word may become a term; it may never become a phrase.

        A split changes the token count upward mid-stream, which is the shape
        that churns a settled prefix on the partial path.
        """
        corrector = LexiconCorrector(("community acquired",))
        assert corrector.correct("communityacquired") == ("communityacquired", [])

    def test_it_is_the_only_path_that_may_cross_scripts(self) -> None:
        """A Malayalam token reaches a Latin term only through an exact authored
        form — never through a distance, which cannot hear either script."""
        corrector = LexiconCorrector(("ബിപി",))
        assert corrector.correct("ബി പി")[0] == "ബിപി"
        assert corrector.correct("രോഗിക്ക് പനി ഉണ്ട്") == ("രോഗിക്ക് പനി ഉണ്ട്", [])

    def test_the_gate_refuses_a_merge_of_ordinary_words(self) -> None:
        corrector = LexiconCorrector(("BP",), protected_vocabulary=("be", "pe"))
        assert corrector.correct("be pe")[1] == []


class TestObservability:
    """The stage has never had a metric — only a DEBUG log and a teardown field
    nothing exports. These are the fields the call site needs to fix that."""

    def test_every_correction_names_the_stage_that_made_it(self) -> None:
        corrector = LexiconCorrector(SERVED_TERMS)
        _, corrections = corrector.correct("cef tri axone and Atorvacetam and septrioxone")
        assert [c.stage for c in corrections] == ["space_agnostic", "graded", "graded"]
        assert all(c.stage in STAGES for c in corrections)

    def test_the_counters_have_a_denominator(self) -> None:
        """A correction counter with no denominator cannot tell 25 % from 0.5 %."""
        stats: dict[str, int] = {}
        corrector = LexiconCorrector(SERVED_TERMS, protected_vocabulary=ORDINARY_WORDS)
        corrector.correct("the patient was creating a certain amount", stats=stats)
        assert stats[TOKENS_SCANNED] == 7

    def test_the_word_gate_is_visible_in_the_counters(self) -> None:
        """The only way the asset's effect is ever measured after it ships."""
        stats: dict[str, int] = {}
        corrector = LexiconCorrector(SERVED_TERMS, protected_vocabulary=ORDINARY_WORDS)
        corrector.correct("creating a certain creatinine", stats=stats)
        assert stats["protected_word"] >= 2

    def test_every_counter_label_is_bounded(self) -> None:
        """A metric label set must be enumerable before the metric exists."""
        stats: dict[str, int] = {}
        corrector = LexiconCorrector(SERVED_TERMS, protected_vocabulary=ORDINARY_WORDS)
        corrector.correct(" ".join(ORDINARY_WORDS[:200]), stats=stats)
        assert set(stats) <= {TOKENS_SCANNED, *REJECTION_REASONS}

    def test_stats_are_opt_in_and_change_nothing(self) -> None:
        corrector = LexiconCorrector(SERVED_TERMS)
        assert corrector.correct("septrioxone") == corrector.correct("septrioxone", stats={})

    def test_the_replacement_is_configured_vocabulary_and_the_original_is_not(self) -> None:
        """Why the INFO line may carry `term` and `stage` but never `original`:
        the replacement is a term the tenant authored, the original is decoder
        output over patient speech, and the log is the one place a transcript can
        be read without decrypting a ContextItem."""
        _, corrections = LexiconCorrector(SERVED_TERMS).correct("septrioxone")
        assert corrections[0].replacement in SERVED_TERMS
        assert corrections[0].original == "septrioxone"


class TestTheContractSurvives:
    """Nothing above may cost the stage a property TASK-935 shipped."""

    def test_correcting_corrected_text_changes_nothing(self) -> None:
        corrector = LexiconCorrector(SERVED_TERMS, protected_vocabulary=ORDINARY_WORDS)
        for heard, _ in MISHEARINGS:
            once, first = corrector.correct(heard)
            twice, second = corrector.correct(once)
            assert first and not second
            assert twice == once

    def test_the_corpus_is_idempotent_under_the_unarmed_matcher_too(self) -> None:
        unarmed = LexiconCorrector(SERVED_TERMS)
        line = " ".join(ORDINARY_WORDS)
        once = unarmed.correct(line)[0]
        assert unarmed.correct(once) == (once, [])

    def test_the_output_is_always_a_configured_term(self) -> None:
        """Closed vocabulary: the stage cannot emit a token the tenant did not name."""
        folded = {term.lower() for term in SERVED_TERMS}
        unarmed = LexiconCorrector(SERVED_TERMS)
        for word in ORDINARY_WORDS:
            for correction in unarmed.correct(word)[1]:
                assert correction.replacement.lower() in folded

    def test_a_term_is_never_consumed_by_its_neighbour_in_the_list(self) -> None:
        corrector = LexiconCorrector(("oxycodone", "oxycontin"))
        assert corrector.correct("oxycodone") == ("oxycodone", [])

    def test_a_phrase_window_never_straddles_punctuation(self) -> None:
        corrector = LexiconCorrector(("community acquired",))
        assert corrector.correct("comunity, aquired")[1] == []

    @pytest.mark.parametrize("text", ["", "   ", "123 456"])
    def test_degenerate_input_is_returned_unchanged(self, text: str) -> None:
        assert LexiconCorrector(SERVED_TERMS).correct(text) == (text, [])
