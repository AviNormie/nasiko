"""The factories: in-memory stores without the platform's state API, durable ones with it."""

from __future__ import annotations

import httpx
import pytest
from a2a.server.tasks import InMemoryTaskStore
from fake_state_server import BASE_URL, TOKEN
from langgraph.checkpoint.memory import MemorySaver
from nasiko_state import (
    NasikoCheckpointSaver,
    NasikoStateError,
    NasikoTaskStore,
    make_checkpointer,
    make_task_store,
)
from sdk_compat import call_context, new_task

pytestmark = pytest.mark.anyio


@pytest.fixture
def no_network(monkeypatch):
    """Any HTTP request at all fails the test."""

    def refuse(self, *args, **kwargs):
        raise AssertionError("the state API was contacted")

    monkeypatch.setattr(httpx.Client, "request", refuse)
    monkeypatch.setattr(httpx.AsyncClient, "request", refuse)


class TestWithoutTheStateApi:
    def test_returns_the_sdk_in_memory_store(self, no_network):
        assert type(make_task_store()) is InMemoryTaskStore

    async def test_works_as_a_store_without_ever_contacting_the_platform(self, no_network):
        store = make_task_store()

        await store.save(new_task("t1", "working"), call_context())

        assert (await store.get("t1", call_context())).id == "t1"

    def test_a_blank_url_counts_as_unset(self, monkeypatch, no_network):
        monkeypatch.setenv("NASIKO_STATE_URL", "   ")

        assert type(make_task_store()) is InMemoryTaskStore

    def test_a_token_alone_changes_nothing(self, monkeypatch, no_network):
        monkeypatch.setenv("NASIKO_AGENT_TOKEN", TOKEN)

        assert type(make_task_store()) is InMemoryTaskStore


class TestWithTheStateApi:
    def test_returns_the_durable_store(self, monkeypatch, no_network):
        monkeypatch.setenv("NASIKO_STATE_URL", BASE_URL)
        monkeypatch.setenv("NASIKO_AGENT_TOKEN", TOKEN)

        assert isinstance(make_task_store(), NasikoTaskStore)

    def test_construction_does_not_register_or_contact_the_platform(self, monkeypatch, no_network):
        monkeypatch.setenv("NASIKO_STATE_URL", BASE_URL)
        monkeypatch.setenv("NASIKO_AGENT_TOKEN", TOKEN)

        make_task_store()  # no_network fails the test if anything is sent

    def test_a_url_without_a_credential_fails_at_startup(self, monkeypatch):
        monkeypatch.setenv("NASIKO_STATE_URL", BASE_URL)

        with pytest.raises(NasikoStateError, match="credential"):
            make_task_store()

    def test_the_gateway_token_alone_is_not_a_state_credential(self, monkeypatch):
        monkeypatch.setenv("NASIKO_STATE_URL", BASE_URL)
        monkeypatch.setenv("MCP_GATEWAY_TOKEN", TOKEN)

        with pytest.raises(NasikoStateError, match="NASIKO_AGENT_TOKEN"):
            make_task_store()


class TestCheckpointerFactory:
    def test_without_the_state_api_it_is_langgraphs_memory_saver(self, no_network):
        assert type(make_checkpointer()) is MemorySaver

    def test_with_the_state_api_it_is_the_durable_saver(self, monkeypatch, no_network):
        monkeypatch.setenv("NASIKO_STATE_URL", BASE_URL)
        monkeypatch.setenv("NASIKO_AGENT_TOKEN", TOKEN)

        assert isinstance(make_checkpointer(), NasikoCheckpointSaver)

    def test_a_url_without_a_credential_fails_at_startup(self, monkeypatch):
        monkeypatch.setenv("NASIKO_STATE_URL", BASE_URL)

        with pytest.raises(NasikoStateError, match="credential"):
            make_checkpointer()
