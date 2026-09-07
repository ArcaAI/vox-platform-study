"""F13 — a degraded node names WHAT failed, not just THAT something did.

Every activity failure — an application error raised inside the activity and a start-to-close
timeout alike — surfaced on the node result as the bare string `activity_error`. A run report
therefore said a node had degraded and nothing else: the 422 from `apps/text`, the 503 from
`apps/nlp`, and a genuine timeout were indistinguishable, which is most of why the two blockers
this ticket fixes took a live black-box run to find at all.

The cause travels now — its TYPE and its message, whitespace-collapsed and length-bounded so a
reason line stays a reason line. The formatting is a pure function so the workflow body stays
deterministic: same failure, same string, on the original run and on every replay.
"""

from __future__ import annotations

from temporalio.exceptions import ActivityError, ApplicationError, TimeoutError, TimeoutType

from harness.temporal.interpreter.workflow import _activity_error_reason


def _activity_error(cause: BaseException | None) -> ActivityError:
    error = ActivityError(
        "activity failed",
        scheduled_event_id=1,
        started_event_id=2,
        identity="worker",
        activity_type="interpreter.core_agent",
        activity_id="1",
        retry_state=None,
    )
    if cause is not None:
        error.__cause__ = cause
    return error


class TestActivityErrorReason:
    def test_an_application_error_carries_its_type_and_message(self) -> None:
        cause = ApplicationError(
            "text generate failed: 422 Unprocessable Entity", type="TextServiceError"
        )

        assert _activity_error_reason(_activity_error(cause)) == (
            "activity_error: TextServiceError: text generate failed: 422 Unprocessable Entity"
        )

    def test_a_timeout_names_which_timeout_fired(self) -> None:
        cause = TimeoutError(
            "activity timeout", type=TimeoutType.START_TO_CLOSE, last_heartbeat_details=[]
        )

        reason = _activity_error_reason(_activity_error(cause))

        assert reason.startswith("activity_error: TimeoutError(START_TO_CLOSE)")

    def test_no_cause_stays_the_bare_reason(self) -> None:
        assert _activity_error_reason(_activity_error(None)) == "activity_error"

    def test_a_typeless_cause_falls_back_to_its_class_name(self) -> None:
        cause = ApplicationError("boom")
        cause._type = None  # an application error the converter could not type

        assert (
            _activity_error_reason(_activity_error(cause))
            == "activity_error: ApplicationError: boom"
        )

    def test_newlines_and_runs_of_whitespace_collapse(self) -> None:
        cause = ApplicationError("line one\n\n   line two", type="ApiServiceError")

        assert _activity_error_reason(_activity_error(cause)) == (
            "activity_error: ApiServiceError: line one line two"
        )

    def test_a_long_message_is_bounded_and_marked(self) -> None:
        cause = ApplicationError("x" * 5000, type="ApiServiceError")

        reason = _activity_error_reason(_activity_error(cause))

        assert len(reason) <= 320
        assert reason.endswith("...")

    def test_it_is_a_pure_function_of_the_error(self) -> None:
        """Replay safety: the same failure formats identically every time it is read."""
        error = _activity_error(ApplicationError("boom", type="ApiServiceError"))

        assert _activity_error_reason(error) == _activity_error_reason(error)
