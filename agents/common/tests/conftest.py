"""Shared fixtures: a fake state server and clients wired to it, with no real sleeping."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# nasiko_state.py is vendored into agents as a top-level module; import it the same way here.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_state_server import BASE_URL, TOKEN, FakeStateServer  # noqa: E402
from nasiko_state import NasikoStateClient  # noqa: E402


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def state_server() -> FakeStateServer:
    return FakeStateServer()


@pytest.fixture
def client(state_server: FakeStateServer) -> NasikoStateClient:
    # Backoff 0: retries are asserted by counting requests, not by waiting.
    return NasikoStateClient(
        BASE_URL, TOKEN, transport=state_server.transport, retry_backoff_seconds=0
    )


@pytest.fixture(autouse=True)
def clean_state_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """No test may pick up the developer's real platform environment."""
    for name in ("NASIKO_STATE_URL", "NASIKO_AGENT_TOKEN", "MCP_GATEWAY_TOKEN"):
        monkeypatch.delenv(name, raising=False)
