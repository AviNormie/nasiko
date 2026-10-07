"""How NasikoTaskStore batches writes: what is written through, what is deferred, in what order."""

from __future__ import annotations

import asyncio
import atexit
import logging
import time

import nasiko_state
import pytest
from fake_state_server import FakeStateServer
from nasiko_state import RETRY_ATTEMPTS, NasikoTaskStore
from sdk_compat import artifact_text, new_task, with_artifact_text, with_state

pytestmark = pytest.mark.anyio

WINDOW = 0.2
LONG_WINDOW = 60


def task_writes(server: FakeStateServer, task_id: str = "t1") -> list:
    return [r for r in server.writes("tasks") if r.path == f"/tasks/{task_id}"]


def written_texts(server: FakeStateServer, task_id: str = "t1") -> list[str | None]:
    """The artifact text of every PUT, in arrival order."""
    texts = []
    for request in task_writes(server, task_id):
        artifacts = request.json["body"].get("artifacts")
        texts.append(artifacts[0]["parts"][0]["text"] if artifacts else None)
    return texts


async def eventually(condition, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


@pytest.fixture
async def store(client):
    task_store = NasikoTaskStore(client, coalesce_window_seconds=WINDOW)
    yield task_store
    await task_store.aclose()


@pytest.fixture
async def default_store(client):
    """The production window, for the one test that states the 500 ms contract literally."""
    task_store = NasikoTaskStore(client)
    yield task_store
    await task_store.aclose()


@pytest.fixture
async def patient_store(client):
    """A window so long that no timer can fire during the test."""
    task_store = NasikoTaskStore(client, coalesce_window_seconds=LONG_WINDOW)
    yield task_store
    await task_store.aclose()


class TestWriteThrough:
    async def test_the_first_save_of_a_task_is_written_immediately(self, patient_store, state_server):
        await patient_store.save(new_task("t1", "submitted"))

        assert len(task_writes(state_server)) == 1

    async def test_input_required_is_on_the_server_before_save_returns(self, patient_store, state_server):
        task = new_task("t1", "working")
        await patient_store.save(task)

        await patient_store.save(with_state(task, "input-required"))

        assert state_server.tasks["t1"].value["state"] == "input-required"

    @pytest.mark.parametrize(
        "state", ["working", "input-required", "auth-required", "completed", "failed", "canceled", "rejected"]
    )
    async def test_every_state_change_is_written_before_save_returns(
        self, patient_store, state_server, state
    ):
        task = new_task("t1", "submitted")
        await patient_store.save(task)

        await patient_store.save(with_state(task, state))

        assert state_server.tasks["t1"].value["state"] == state
        assert len(task_writes(state_server)) == 2

    async def test_a_state_change_carries_the_updates_that_were_waiting(self, patient_store, state_server):
        task = new_task("t1", "working", artifact_text="1")
        await patient_store.save(task)
        await patient_store.save(with_artifact_text(task, "2"))
        await patient_store.save(with_artifact_text(task, "3"))

        await patient_store.save(with_state(task, "input-required"))

        assert written_texts(state_server) == ["1", "3"]


class TestCoalescing:
    async def test_three_updates_within_100ms_make_one_write(self, default_store, state_server):
        task = new_task("t1", "working", artifact_text="0")
        await default_store.save(task)  # first save: written through
        for text in ("1", "2", "3"):
            await default_store.save(with_artifact_text(task, text))
            await asyncio.sleep(0.03)

        assert len(task_writes(state_server)) == 1  # nothing deferred has landed yet
        await eventually(lambda: len(task_writes(state_server)) == 2)
        await asyncio.sleep(0.6)

        assert written_texts(state_server) == ["0", "3"]  # one write, carrying the newest content

    async def test_writes_are_at_most_one_per_window(self, store, state_server):
        task = new_task("t1", "working", artifact_text="0")
        started = time.monotonic()
        await store.save(task)
        for n in range(1, 61):
            await store.save(with_artifact_text(task, str(n)))
            await asyncio.sleep(0.02)
        elapsed = time.monotonic() - started
        await eventually(lambda: written_texts(state_server)[-1] == "60")

        writes = len(task_writes(state_server))

        assert writes <= elapsed / WINDOW + 2
        assert writes >= 3  # it did keep flushing while updates kept coming

    async def test_the_newest_update_always_lands(self, store, state_server):
        task = new_task("t1", "working", artifact_text="0")
        await store.save(task)
        for n in range(1, 8):
            await store.save(with_artifact_text(task, str(n)))

        await eventually(lambda: written_texts(state_server)[-1] == "7")

    async def test_an_idle_task_gets_its_next_update_after_at_most_one_window(self, store, state_server):
        task = new_task("t1", "working", artifact_text="0")
        await store.save(task)
        await asyncio.sleep(WINDOW * 2)  # the previous write is long outside the window

        started = time.monotonic()
        await store.save(with_artifact_text(task, "1"))
        await eventually(lambda: written_texts(state_server)[-1] == "1")

        assert time.monotonic() - started < WINDOW  # due immediately, not a full window later

    async def test_tasks_are_throttled_independently(self, store, state_server):
        for task_id in ("a", "b"):
            task = new_task(task_id, "working", artifact_text="0")
            await store.save(task)
            await store.save(with_artifact_text(task, "1"))

        await eventually(lambda: written_texts(state_server, "a")[-1] == "1")
        await eventually(lambda: written_texts(state_server, "b")[-1] == "1")


class TestTerminalStates:
    async def test_completion_flushes_pending_updates_in_a_single_write(self, patient_store, state_server):
        task = new_task("t1", "working", artifact_text="1")
        await patient_store.save(task)
        await patient_store.save(with_artifact_text(task, "2"))
        await patient_store.save(with_artifact_text(task, "3"))

        await patient_store.save(with_state(task, "completed"))
        await asyncio.sleep(0.05)

        assert state_server.tasks["t1"].value["state"] == "completed"
        assert written_texts(state_server) == ["1", "3"]  # nothing stale is written afterwards

    async def test_a_finished_task_leaves_no_bookkeeping_behind(self, patient_store, state_server):
        task = new_task("t1", "working")
        await patient_store.save(task)
        await patient_store.save(with_state(task, "completed"))

        assert "t1" not in patient_store._slots

    async def test_a_finished_task_still_reads_back(self, patient_store):
        task = new_task("t1", "working", artifact_text="done")
        await patient_store.save(task)
        await patient_store.save(with_state(task, "completed"))

        assert artifact_text(await patient_store.get("t1")) == "done"


class TestOrdering:
    async def test_writes_arrive_in_save_order(self, patient_store, state_server):
        task = new_task("t1", "working", artifact_text="1")
        await patient_store.save(task)
        for text in ("2", "3"):
            await patient_store.save(with_artifact_text(task, text))
        await patient_store.save(with_artifact_text(with_state(task, "input-required"), "4"))
        for text in ("5", "6"):
            await patient_store.save(with_artifact_text(task, text))
        await patient_store.aclose()

        assert written_texts(state_server) == ["1", "4", "6"]
        assert state_server.tasks["t1"].value["state"] == "input-required"

    async def test_a_slow_deferred_write_cannot_land_after_a_newer_state_change(self, client, state_server):
        store = NasikoTaskStore(client, coalesce_window_seconds=0.05)
        task = new_task("t1", "working", artifact_text="1")
        await store.save(task)

        entered, release = asyncio.Event(), asyncio.Event()
        held = []

        async def hold_the_next_put(request):
            if request.method == "PUT" and not held:
                held.append(request)
                entered.set()
                await release.wait()

        state_server.gate = hold_the_next_put
        await store.save(with_artifact_text(task, "2"))  # deferred: its timer will start a write
        await asyncio.wait_for(entered.wait(), 3)  # that write is now in flight and held
        change = asyncio.create_task(store.save(with_artifact_text(with_state(task, "input-required"), "3")))
        await asyncio.sleep(0.1)
        release.set()
        await change
        await store.aclose()

        assert written_texts(state_server) == ["1", "2", "3"]
        assert state_server.tasks["t1"].value["state"] == "input-required"


class TestReads:
    async def test_get_sees_this_processs_unwritten_update(self, patient_store, state_server):
        task = new_task("t1", "working", artifact_text="1")
        await patient_store.save(task)
        await patient_store.save(with_artifact_text(task, "2"))

        assert artifact_text(await patient_store.get("t1")) == "2"
        assert written_texts(state_server) == ["1"]  # the server has not seen it yet


class TestShutdown:
    async def test_aclose_writes_what_is_pending(self, client, state_server):
        store = NasikoTaskStore(client, coalesce_window_seconds=LONG_WINDOW)
        task = new_task("t1", "working", artifact_text="1")
        await store.save(task)
        await store.save(with_artifact_text(task, "2"))

        await store.aclose()

        assert written_texts(state_server) == ["1", "2"]

    async def test_aclose_with_a_failing_server_raises_instead_of_dropping_silently(
        self, client, state_server
    ):
        from nasiko_state import NasikoStateError

        store = NasikoTaskStore(client, coalesce_window_seconds=LONG_WINDOW)
        task = new_task("t1", "working", artifact_text="1")
        await store.save(task)
        await store.save(with_artifact_text(task, "2"))
        state_server.fail(503, times=RETRY_ATTEMPTS)

        with pytest.raises(NasikoStateError):
            await store.aclose()

    async def test_the_exit_hook_flushes_through_the_sync_client(self, client, state_server, monkeypatch):
        registered = []
        monkeypatch.setattr(atexit, "register", lambda function: registered.append(function))
        store = NasikoTaskStore(client, coalesce_window_seconds=LONG_WINDOW)
        task = new_task("t1", "working", artifact_text="1")
        await store.save(task)
        await store.save(with_artifact_text(task, "2"))
        assert written_texts(state_server) == ["1"]

        assert len(registered) == 1
        registered[0]()  # what the interpreter does at exit, after the event loop is gone

        assert written_texts(state_server) == ["1", "2"]
        registered[0]()  # idempotent: nothing is written twice
        assert written_texts(state_server) == ["1", "2"]

    async def test_aclose_deregisters_the_exit_hook(self, client, monkeypatch):
        unregistered = []
        monkeypatch.setattr(atexit, "unregister", lambda function: unregistered.append(function))
        store = NasikoTaskStore(client)

        await store.aclose()

        assert unregistered == [store.flush_sync]

    async def test_the_exit_flush_gives_up_when_its_budget_is_spent(
        self, client, state_server, monkeypatch, caplog
    ):
        store = NasikoTaskStore(client, coalesce_window_seconds=LONG_WINDOW)
        task = new_task("t1", "working", artifact_text="1")
        await store.save(task)
        await store.save(with_artifact_text(task, "2"))
        monkeypatch.setattr(nasiko_state, "EXIT_FLUSH_BUDGET_SECONDS", -1)

        with caplog.at_level(logging.ERROR, logger="nasiko_state"):
            store.flush_sync()

        assert "budget" in caplog.text
        assert written_texts(state_server) == ["1"]
        atexit.unregister(store.flush_sync)
        await store.aclose()

    async def test_a_failed_exit_flush_is_logged_and_the_rest_still_written(
        self, client, state_server, caplog
    ):
        store = NasikoTaskStore(client, coalesce_window_seconds=LONG_WINDOW)
        for task_id in ("a", "b"):
            task = new_task(task_id, "working", artifact_text="1")
            await store.save(task)
            await store.save(with_artifact_text(task, "2"))
        state_server.fail(413, when=lambda r: r.method == "PUT" and r.path == "/tasks/a")

        with caplog.at_level(logging.ERROR, logger="nasiko_state"):
            store.flush_sync()

        assert "exit flush of task a failed" in caplog.text
        assert written_texts(state_server, "b") == ["1", "2"]
        atexit.unregister(store.flush_sync)

    async def test_a_hard_crash_loses_only_the_unflushed_non_status_updates(self, client, state_server):
        store = NasikoTaskStore(client, coalesce_window_seconds=LONG_WINDOW)
        task = new_task("t1", "working", artifact_text="1")
        await store.save(task)
        await store.save(with_state(task, "input-required"))  # a state change: durable at once
        await store.save(with_artifact_text(task, "2"))  # inside the window when the process dies
        atexit.unregister(store.flush_sync)  # a crash never runs exit hooks
        store._slots["t1"].flusher.cancel()

        assert state_server.tasks["t1"].value["state"] == "input-required"
        assert written_texts(state_server) == ["1", "1"]


class TestDeferredFailures:
    async def test_a_failed_deferred_write_is_logged_and_retried_by_the_next_save(
        self, store, state_server, caplog
    ):
        task = new_task("t1", "working", artifact_text="0")
        await store.save(task)
        state_server.fail(500, times=RETRY_ATTEMPTS, when=lambda r: r.method == "PUT")
        with caplog.at_level(logging.ERROR, logger="nasiko_state"):
            await store.save(with_artifact_text(task, "1"))
            await eventually(lambda: "deferred task write failed" in caplog.text)

        await store.save(with_artifact_text(task, "2"))
        await eventually(lambda: written_texts(state_server)[-1] == "2")

    async def test_delete_discards_a_pending_update_so_it_cannot_resurrect_the_task(
        self, patient_store, state_server
    ):
        task = new_task("t1", "working", artifact_text="1")
        await patient_store.save(task)
        await patient_store.save(with_artifact_text(task, "2"))

        await patient_store.delete("t1")
        await patient_store.aclose()

        assert "t1" not in state_server.tasks


class TestBoundedMemory:
    async def test_idle_slots_are_evicted_beyond_the_cap(self, client, state_server, monkeypatch):
        monkeypatch.setattr(nasiko_state, "MAX_TRACKED_TASKS", 3)
        store = NasikoTaskStore(client, coalesce_window_seconds=LONG_WINDOW)
        for n in range(6):
            await store.save(new_task(f"t{n}", "working"))

        assert len(store._slots) == 3
        assert list(store._slots) == ["t3", "t4", "t5"]  # the least recently used went first
        await store.aclose()

    async def test_a_forgotten_task_costs_one_extra_write_not_correctness(
        self, client, state_server, monkeypatch
    ):
        monkeypatch.setattr(nasiko_state, "MAX_TRACKED_TASKS", 1)
        store = NasikoTaskStore(client, coalesce_window_seconds=LONG_WINDOW)
        first = new_task("t1", "working", artifact_text="1")
        await store.save(first)
        await store.save(new_task("t2", "working"))  # evicts t1's slot

        await store.save(with_artifact_text(first, "2"))  # unknown again, so written through

        assert written_texts(state_server) == ["1", "2"]
        await store.aclose()

    async def test_slots_owing_a_write_are_never_evicted(self, client, state_server, monkeypatch):
        monkeypatch.setattr(nasiko_state, "MAX_TRACKED_TASKS", 1)
        store = NasikoTaskStore(client, coalesce_window_seconds=LONG_WINDOW)
        first = new_task("t1", "working", artifact_text="1")
        await store.save(first)
        await store.save(with_artifact_text(first, "2"))  # pending
        await store.save(new_task("t2", "working"))

        assert list(store._slots) == ["t1", "t2"]  # over the cap rather than losing a pending write
        await store.aclose()
        assert written_texts(state_server) == ["1", "2"]
