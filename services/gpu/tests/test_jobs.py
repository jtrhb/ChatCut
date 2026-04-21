from src.jobs import (
    JobResult,
    JobState,
    initial_state,
    mark_done,
    mark_failed,
    new_job_id,
    update_progress,
)


class TestNewJobId:
    def test_returns_unique_strings(self):
        ids = {new_job_id() for _ in range(100)}
        assert len(ids) == 100

    def test_returns_hex(self):
        assert all(c in "0123456789abcdef" for c in new_job_id())


class TestInitialState:
    def test_starts_queued_at_zero(self):
        s = initial_state("job-1")
        assert s.job_id == "job-1"
        assert s.state == "queued"
        assert s.progress == 0
        assert s.result is None
        assert s.error is None


class TestUpdateProgress:
    def test_transitions_to_running_with_clamped_value(self):
        s = update_progress(initial_state("j"), 25)
        assert s.state == "running"
        assert s.progress == 25

    def test_clamps_above_100(self):
        assert update_progress(initial_state("j"), 150).progress == 100

    def test_clamps_below_zero(self):
        assert update_progress(initial_state("j"), -10).progress == 0

    def test_monotonic_does_not_decrease(self):
        s = update_progress(initial_state("j"), 50)
        s = update_progress(s, 30)
        assert s.progress == 50


class TestMarkDone:
    def test_sets_done_with_result(self):
        s = mark_done(initial_state("j"), "previews/x/y.mp4")
        assert s.state == "done"
        assert s.progress == 100
        assert s.result == JobResult(storage_key="previews/x/y.mp4")


class TestMarkFailed:
    def test_sets_failed_with_error(self):
        s = mark_failed(initial_state("j"), "boom")
        assert s.state == "failed"
        assert s.error == "boom"


class TestJobStateSerialization:
    def test_round_trip(self):
        s = mark_done(update_progress(initial_state("j"), 10), "key")
        assert JobState.model_validate(s.model_dump()) == s
