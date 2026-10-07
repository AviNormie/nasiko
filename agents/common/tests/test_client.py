"""NasikoStateClient against the fake state server, through both its sync and async methods."""

from __future__ import annotations

import asyncio
import time

import httpx
import pytest
from fake_state_server import BASE_URL, TOKEN, Recorded
from nasiko_state import (
    CLIENT_NAME,
    RETRY_ATTEMPTS,
    NasikoStateClient,
    NasikoStateConflict,
    NasikoStateError,
    NasikoStateTooLarge,
)

pytestmark = pytest.mark.anyio


@pytest.fixture(params=["sync", "async"])
def style(request: pytest.FixtureRequest) -> str:
    return request.param


@pytest.fixture
def slept(monkeypatch) -> list[float]:
    """Every retry wait the client asks for, sync or async, without actually waiting."""
    waits: list[float] = []
    real_asleep = asyncio.sleep

    def sleep(seconds: float) -> None:
        waits.append(seconds)

    async def asleep(seconds: float) -> None:
        waits.append(seconds)
        await real_asleep(0)

    monkeypatch.setattr(time, "sleep", sleep)
    monkeypatch.setattr(asyncio, "sleep", asleep)
    return waits


async def call(client: NasikoStateClient, style: str, method: str, *args, **kwargs):
    """Invoke `method` on the sync API, or `a<method>` on the async one, so each test covers both."""
    if style == "sync":
        return getattr(client, method)(*args, **kwargs)
    return await getattr(client, "a" + method)(*args, **kwargs)


def put_task(client, style, task_id="t1", **kwargs):
    fields = {"context_id": "c1", "state": "working", "body": {"n": 1}}
    return call(client, style, "put_task", task_id, **{**fields, **kwargs})


def is_register(request: Recorded) -> bool:
    return request.path == "/register"


class TestRegistration:
    async def test_first_task_write_registers_once(self, client, state_server, style):
        await put_task(client, style, "t1")
        await put_task(client, style, "t2")
        await put_task(client, style, "t1", body={"n": 2})

        assert state_server.registrations == [{"capabilities": ["tasks"], "client": CLIENT_NAME}]

    async def test_a_second_kind_of_write_registers_the_union(self, client, state_server, style):
        await put_task(client, style)
        await call(client, style, "put_kv", "k", {"a": 1})
        await call(client, style, "put_kv", "k", {"a": 2})

        assert [r["capabilities"] for r in state_server.registrations] == [["tasks"], ["tasks", "kv"]]

    async def test_kv_only_agents_register_kv_alone(self, client, state_server, style):
        await call(client, style, "put_kv", "k", 1)

        assert [r["capabilities"] for r in state_server.registrations] == [["kv"]]

    async def test_reads_and_listings_do_not_register(self, client, state_server, style):
        await call(client, style, "get_task", "missing")
        await call(client, style, "list_tasks")
        await call(client, style, "get_kv", "missing")

        assert not any(is_register(r) for r in state_server.requests)

    async def test_registration_precedes_the_first_write(self, client, state_server, style):
        await put_task(client, style)

        assert [r.path for r in state_server.requests][:2] == ["/register", "/tasks/t1"]

    async def test_a_failed_registration_is_retried_by_the_next_write(self, client, state_server, style):
        state_server.fail(400, when=is_register)
        with pytest.raises(NasikoStateError):
            await put_task(client, style)

        await put_task(client, style)

        assert len(state_server.registrations) == 1
        assert len(state_server.writes("tasks")) == 1

    async def test_explicit_registration_sends_the_given_client_name(self, client, state_server, style):
        await call(client, style, "register", ["tasks", "kv"], "my-sdk/9")

        assert state_server.registrations == [{"capabilities": ["tasks", "kv"], "client": "my-sdk/9"}]


class TestTaskEndpoints:
    async def test_put_get_delete_round_trip(self, client, state_server, style):
        receipt = await put_task(client, style, body={"deep": {"list": [1, 2, 3]}}, state="input-required")
        record = await call(client, style, "get_task", "t1")

        assert receipt.version == 1
        assert (record.task_id, record.context_id, record.state) == ("t1", "c1", "input-required")
        assert record.body == {"deep": {"list": [1, 2, 3]}}
        assert record.version == 1
        assert record.expires_at
        assert await call(client, style, "delete_task", "t1") is True
        assert await call(client, style, "get_task", "t1") is None

    async def test_version_increments_on_every_write(self, client, style):
        versions = [(await put_task(client, style, body={"n": n})).version for n in range(3)]

        assert versions == [1, 2, 3]

    async def test_a_null_context_id_is_sent_as_null(self, client, state_server, style):
        await put_task(client, style, context_id=None)

        assert state_server.writes("tasks")[0].json["context_id"] is None

    async def test_missing_task_reads_as_none_and_deletes_as_false(self, client, style):
        assert await call(client, style, "get_task", "nope") is None
        assert await call(client, style, "delete_task", "nope") is False

    async def test_ids_with_reserved_characters_stay_one_path_segment(self, client, state_server, style):
        awkward = "a/b:c%d e?f"
        await put_task(client, style, awkward)

        assert (await call(client, style, "get_task", awkward)).task_id == awkward
        assert list(state_server.tasks) == [awkward]

    async def test_every_request_carries_the_bearer_token(self, client, state_server, style):
        await put_task(client, style)
        await call(client, style, "get_task", "t1")

        assert {r.headers["authorization"] for r in state_server.requests} == {f"Bearer {TOKEN}"}

    async def test_listing_filters_and_paginates(self, client, state_server, style):
        for n in range(5):
            await put_task(client, style, f"t{n}", context_id="even" if n % 2 == 0 else "odd")

        first = await call(client, style, "list_tasks", limit=2)
        second = await call(client, style, "list_tasks", limit=2, cursor=first.next_cursor)
        evens = await call(client, style, "list_tasks", context_id="even")

        assert [t.task_id for t in first.items] == ["t4", "t3"]
        assert [t.task_id for t in second.items] == ["t2", "t1"]
        assert sorted(t.task_id for t in evens.items) == ["t0", "t2", "t4"]
        assert evens.next_cursor is None

    async def test_listing_filters_by_state(self, client, style):
        await put_task(client, style, "a", state="working")
        await put_task(client, style, "b", state="input-required")

        paused = await call(client, style, "list_tasks", state="input-required")

        assert [t.task_id for t in paused.items] == ["b"]


class TestKvEndpoints:
    async def test_round_trip_and_prefix_listing(self, client, style):
        for key in ("lg:a:1", "lg:a:2", "other"):
            await call(client, style, "put_kv", key, {"key": key})

        record = await call(client, style, "get_kv", "lg:a:2")
        listed = await call(client, style, "list_kv", prefix="lg:a:")

        assert record.value == {"key": "lg:a:2"}
        assert [r.key for r in listed.items] == ["lg:a:1", "lg:a:2"]
        assert await call(client, style, "delete_kv", "other") is True
        assert await call(client, style, "delete_kv", "other") is False
        assert await call(client, style, "get_kv", "other") is None

    async def test_values_may_be_any_json(self, client, style):
        for value in (None, 0, "text", [1, {"a": None}], {"nested": {"x": [True]}}):
            await call(client, style, "put_kv", "k", value)
            assert (await call(client, style, "get_kv", "k")).value == value


class TestConflicts:
    async def test_stale_if_match_raises_a_conflict_with_the_current_version(self, client, style):
        await put_task(client, style)
        await put_task(client, style)

        with pytest.raises(NasikoStateConflict) as raised:
            await put_task(client, style, if_match=1)

        assert raised.value.status == 412
        assert raised.value.current_version == 2
        assert isinstance(raised.value, NasikoStateError)

    async def test_matching_if_match_writes(self, client, style):
        await put_task(client, style)

        receipt = await put_task(client, style, if_match=1)

        assert receipt.version == 2

    async def test_delete_honours_if_match(self, client, style):
        await call(client, style, "put_kv", "k", 1)
        await call(client, style, "put_kv", "k", 2)

        with pytest.raises(NasikoStateConflict):
            await call(client, style, "delete_kv", "k", if_match=1)
        assert await call(client, style, "delete_kv", "k", if_match=2) is True

    async def test_if_match_is_sent_as_a_bare_integer(self, client, state_server, style):
        await put_task(client, style)
        await put_task(client, style, if_match=1)

        assert state_server.writes("tasks")[1].headers["if-match"] == "1"


class TestFailures:
    async def test_oversized_body_raises_too_large_with_status_and_body(self, client, state_server, style):
        state_server.max_body_bytes = 10

        with pytest.raises(NasikoStateTooLarge) as raised:
            await put_task(client, style, body={"big": "x" * 100})

        assert raised.value.status == 413
        assert "body too large" in raised.value.body
        assert "413" in str(raised.value)

    async def test_a_rate_limit_longer_than_the_bound_raises_without_waiting(
        self, client, state_server, style, slept
    ):
        state_server.rate_limit = 0  # answers 429 with Retry-After: 7

        with pytest.raises(NasikoStateError) as raised:
            await call(client, style, "get_task", "t1")

        assert raised.value.status == 429
        assert "retry after 7s" in str(raised.value)
        assert len(state_server.requests) == 1
        assert slept == []

    async def test_unknown_token_is_refused(self, state_server, style):
        stranger = NasikoStateClient(BASE_URL, "wrong", transport=state_server.transport)

        with pytest.raises(NasikoStateError) as raised:
            await call(stranger, style, "get_task", "t1")

        assert raised.value.status == 401

    async def test_503_is_retried_until_it_succeeds(self, client, state_server, style):
        await put_task(client, style)  # registers, so only the retried request is counted below
        state_server.requests.clear()
        state_server.fail(503, times=2, when=lambda r: r.path == "/tasks/t1")

        record = await call(client, style, "get_task", "t1")

        assert record.task_id == "t1"
        assert len(state_server.requests) == 3

    async def test_connection_errors_are_retried(self, client, state_server, style):
        state_server.disconnect(times=2)

        assert await call(client, style, "get_task", "t1") is None
        assert len(state_server.requests) == 3

    async def test_retries_are_bounded(self, client, state_server, style):
        state_server.fail(503, times=100)

        with pytest.raises(NasikoStateError) as raised:
            await call(client, style, "get_task", "t1")

        assert raised.value.status == 503
        assert len(state_server.requests) == RETRY_ATTEMPTS

    async def test_unreachable_server_raises_after_bounded_attempts(self, client, state_server, style):
        state_server.disconnect(times=100)

        with pytest.raises(NasikoStateError) as raised:
            await call(client, style, "get_task", "t1")

        assert raised.value.status is None
        assert "could not be reached" in str(raised.value) or "request failed" in str(raised.value)
        assert len(state_server.requests) == RETRY_ATTEMPTS

    async def test_a_429_is_retried_after_the_wait_the_server_names(self, client, state_server, style, slept):
        state_server.fail(429, headers={"Retry-After": "2"})

        assert await call(client, style, "get_task", "t1") is None

        assert slept == [2.0]
        assert len(state_server.requests) == 2

    async def test_a_429_without_retry_after_backs_off_like_a_5xx(self, client, state_server, style, slept):
        state_server.fail(429, times=RETRY_ATTEMPTS - 1)

        assert await call(client, style, "get_task", "t1") is None

        assert len(slept) == RETRY_ATTEMPTS - 1

    async def test_429_retries_are_bounded(self, client, state_server, style, slept):
        state_server.fail(429, times=100, headers={"Retry-After": "1"})

        with pytest.raises(NasikoStateError) as raised:
            await call(client, style, "get_task", "t1")

        assert raised.value.status == 429
        assert len(state_server.requests) == RETRY_ATTEMPTS

    @pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 413, 422])
    async def test_client_errors_are_never_retried(self, client, state_server, style, status):
        state_server.fail(status, times=100)

        with pytest.raises(NasikoStateError) as raised:
            await put_task(client, style)

        assert raised.value.status == status
        assert len(state_server.requests) == 1

    async def test_a_non_json_answer_is_reported_not_crashed_on(self, style):
        transport = httpx.MockTransport(lambda request: httpx.Response(200, text="<html>proxy page</html>"))
        broken = NasikoStateClient(BASE_URL, TOKEN, transport=transport, retry_backoff_seconds=0)

        with pytest.raises(NasikoStateError, match="invalid JSON"):
            await call(broken, style, "get_task", "t1")

    async def test_an_answer_missing_fields_is_reported(self, style):
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"task_id": "t1"}))
        broken = NasikoStateClient(BASE_URL, TOKEN, transport=transport, retry_backoff_seconds=0)

        with pytest.raises(NasikoStateError, match="TaskRecord"):
            await call(broken, style, "get_task", "t1")


class TestConstruction:
    def test_the_token_never_appears_in_repr_or_errors(self, state_server):
        secret = NasikoStateClient(BASE_URL, "super-secret-token", transport=state_server.transport)

        assert "super-secret-token" not in repr(secret)

    def test_rejects_a_url_that_is_not_http(self):
        with pytest.raises(NasikoStateError, match="http"):
            NasikoStateClient("state.internal/api", TOKEN)

    def test_rejects_an_empty_token(self):
        with pytest.raises(NasikoStateError, match="token"):
            NasikoStateClient(BASE_URL, "")

    def test_timeouts_are_two_seconds_to_connect_and_ten_to_read(self, client):
        http = client._sync_http()

        assert http.timeout.connect == 2.0
        assert http.timeout.read == 10.0


class TestFromEnv:
    def test_no_url_means_no_state_api(self):
        assert NasikoStateClient.from_env({}) is None
        assert NasikoStateClient.from_env({"NASIKO_STATE_URL": "  "}) is None

    def test_agent_token_wins_over_the_gateway_token(self):
        client = NasikoStateClient.from_env(
            {"NASIKO_STATE_URL": BASE_URL, "NASIKO_AGENT_TOKEN": "agent", "MCP_GATEWAY_TOKEN": "gateway"}
        )

        assert client._headers["Authorization"] == "Bearer agent"

    def test_falls_back_to_the_gateway_token(self):
        client = NasikoStateClient.from_env({"NASIKO_STATE_URL": BASE_URL, "MCP_GATEWAY_TOKEN": "gateway"})

        assert client._headers["Authorization"] == "Bearer gateway"

    def test_a_url_without_any_token_is_a_configuration_error(self):
        with pytest.raises(NasikoStateError, match="NASIKO_AGENT_TOKEN"):
            NasikoStateClient.from_env({"NASIKO_STATE_URL": BASE_URL})

    def test_reads_the_process_environment_by_default(self, monkeypatch):
        monkeypatch.setenv("NASIKO_STATE_URL", BASE_URL)
        monkeypatch.setenv("NASIKO_AGENT_TOKEN", "from-os-environ")

        assert NasikoStateClient.from_env()._headers["Authorization"] == "Bearer from-os-environ"


class TestLifecycle:
    async def test_closed_clients_reopen_on_next_use(self, client, state_server):
        await put_task(client, "async")
        await client.aclose()

        assert (await client.aget_task("t1")).task_id == "t1"
