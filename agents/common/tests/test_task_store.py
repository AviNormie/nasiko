"""NasikoTaskStore as the SDK's TaskStore: round trips, reads, deletes, listing."""

from __future__ import annotations

import pytest
from fake_state_server import Row
from nasiko_state import NasikoStateError, NasikoTaskStore
from sdk_compat import (
    A2A_V1,
    artifact_text,
    new_task,
    state_name,
    with_artifact_text,
)

pytestmark = pytest.mark.anyio

LONG_WINDOW = 60  # nothing flushes by timer inside a test; coalescing has its own module


@pytest.fixture
async def store(client):
    task_store = NasikoTaskStore(client, coalesce_window_seconds=LONG_WINDOW)
    yield task_store
    await task_store.aclose()


class TestRoundTrip:
    async def test_a_saved_task_reads_back_equal(self, store):
        task = new_task("t1", "working", artifact_text="hello")

        await store.save(task)

        assert await store.get("t1") == task

    async def test_state_and_context_columns_come_from_the_task(self, store, state_server):
        await store.save(new_task("t1", "input-required", context_id="ctx-9"))

        row = state_server.tasks["t1"].value
        assert (row["state"], row["context_id"]) == ("input-required", "ctx-9")

    async def test_get_of_an_unknown_task_is_none(self, store):
        assert await store.get("nope") is None

    async def test_delete_removes_the_task_and_is_idempotent(self, store, state_server):
        await store.save(new_task("t1", "working"))

        await store.delete("t1")
        await store.delete("t1")

        assert "t1" not in state_server.tasks
        assert await store.get("t1") is None

    async def test_a_save_is_a_snapshot_not_a_reference(self, store):
        task = new_task("t1", "working", artifact_text="before")
        await store.save(task)

        with_artifact_text(task, "after")  # the SDK keeps mutating its task after saving it
        seen = await store.get("t1")

        assert artifact_text(seen) == "before"

    async def test_get_returns_a_fresh_object_each_time(self, store):
        await store.save(new_task("t1", "working"))

        first, second = await store.get("t1"), await store.get("t1")

        assert first == second and first is not second

    async def test_ids_with_reserved_characters_round_trip(self, store, state_server):
        awkward = "task/with:odd chars?and%percent"
        await store.save(new_task(awkward, "working"))

        assert (await store.get(awkward)).id == awkward
        assert list(state_server.tasks) == [awkward]

    async def test_saving_registers_for_tasks_only(self, store, state_server):
        await store.save(new_task("t1", "working"))

        assert [r["capabilities"] for r in state_server.registrations] == [["tasks"]]

    async def test_reads_alone_never_register(self, store, state_server):
        await store.get("t1")

        assert state_server.registrations == []


class TestFailures:
    async def test_a_rejected_save_raises_and_the_store_keeps_working(self, store, state_server):
        state_server.fail(413, when=lambda r: r.method == "PUT" and r.path.startswith("/tasks"))

        with pytest.raises(NasikoStateError) as raised:
            await store.save(new_task("t1", "working"))
        await store.save(new_task("t1", "working"))

        assert raised.value.status == 413
        assert "t1" in state_server.tasks

    async def test_a_state_change_that_failed_is_written_through_again_by_the_next_save(self, store, state_server):
        await store.save(new_task("t1", "working"))
        state_server.fail(500, times=3, when=lambda r: r.method == "PUT" and r.path.startswith("/tasks"))
        with pytest.raises(NasikoStateError):
            await store.save(new_task("t1", "input-required"))

        await store.save(new_task("t1", "input-required"))

        assert state_server.tasks["t1"].value["state"] == "input-required"

    async def test_a_row_that_does_not_decode_is_an_error_not_a_missing_task(self, store, state_server):
        state_server.tasks["t1"] = Row({"task_id": "t1", "state": "working", "body": {"id": 12}}, 1, 1)

        with pytest.raises(NasikoStateError, match="t1"):
            await store.get("t1")

    async def test_an_empty_body_is_an_error_not_an_empty_task(self, store, state_server):
        state_server.tasks["t1"] = Row({"task_id": "t1", "state": "working", "body": {}}, 1, 1)

        with pytest.raises(NasikoStateError, match="t1"):
            await store.get("t1")

    async def test_a_body_for_another_task_is_an_error(self, store, state_server):
        other = new_task("someone-else", "working")
        await store.save(other)
        state_server.tasks["t1"] = Row(
            {"task_id": "t1", "state": "working", "body": state_server.tasks["someone-else"].value["body"]}, 1, 1
        )

        with pytest.raises(NasikoStateError, match="someone-else"):
            await store.get("t1")


@pytest.mark.skipif(not A2A_V1, reason="tasks/list joined the TaskStore interface in a2a-sdk 1.x")
class TestListing:
    @staticmethod
    def request(**fields):
        from a2a.types import ListTasksRequest

        return ListTasksRequest(**fields)

    async def test_lists_decoded_tasks_newest_first(self, store):
        for n in range(3):
            await store.save(new_task(f"t{n}", "working", artifact_text=f"text {n}"))

        response = await store.list(self.request())

        assert [t.id for t in response.tasks] == ["t2", "t1", "t0"]
        assert artifact_text(response.tasks[0]) == "text 2"
        assert response.next_page_token == ""

    async def test_filters_by_context_and_state(self, store):
        from a2a.types import TaskState

        await store.save(new_task("a", "working", context_id="one"))
        await store.save(new_task("b", "input-required", context_id="one"))
        await store.save(new_task("c", "input-required", context_id="two"))

        paused_in_one = await store.list(
            self.request(context_id="one", status=TaskState.TASK_STATE_INPUT_REQUIRED)
        )

        assert [t.id for t in paused_in_one.tasks] == ["b"]
        assert {state_name(t) for t in paused_in_one.tasks} == {"input-required"}

    async def test_paginates_with_page_tokens(self, store):
        for n in range(5):
            await store.save(new_task(f"t{n}", "working"))

        first = await store.list(self.request(page_size=2))
        second = await store.list(self.request(page_size=2, page_token=first.next_page_token))
        last = await store.list(self.request(page_size=2, page_token=second.next_page_token))

        assert [t.id for t in first.tasks] == ["t4", "t3"]
        assert [t.id for t in second.tasks] == ["t2", "t1"]
        assert [t.id for t in last.tasks] == ["t0"]
        assert last.next_page_token == ""
        assert first.page_size == 2

    async def test_the_default_page_is_fifty_tasks(self, store, state_server):
        await store.list(self.request())

        assert state_server.calls("GET", "/tasks")[0].query == {"limit": "50"}

    async def test_a_timestamp_filter_is_refused_rather_than_ignored(self, store):
        from a2a.types import ListTasksRequest
        from a2a.utils.errors import UnsupportedOperationError
        from google.protobuf.timestamp_pb2 import Timestamp

        request = ListTasksRequest(status_timestamp_after=Timestamp(seconds=1))

        with pytest.raises(UnsupportedOperationError, match="status_timestamp_after"):
            await store.list(request)

    async def test_a_server_refusal_surfaces_as_a_state_error(self, store, state_server):
        state_server.fail(400, when=lambda r: r.path == "/tasks")

        with pytest.raises(NasikoStateError) as raised:
            await store.list(self.request(page_token="garbage"))

        assert raised.value.status == 400


@pytest.mark.skipif(A2A_V1, reason="0.3.x TaskStore has no list method")
def test_the_0_3_store_does_not_pretend_to_list(client):
    assert not hasattr(NasikoTaskStore(client), "list")
