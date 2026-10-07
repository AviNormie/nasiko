"""Durable agent state over the platform's state API.

An A2A agent normally keeps its tasks in process memory, so a restart loses paused work
and the agent cannot run as more than one replica. This module is a drop-in replacement
that keeps that state in the platform instead.

    from nasiko_state import make_task_store

    handler = DefaultRequestHandler(
        agent_executor=MyExecutor(),
        task_store=make_task_store(),   # was: InMemoryTaskStore()
        agent_card=card,
    )

Configuration comes from the environment the platform injects into the container:

    NASIKO_STATE_URL     base URL of the state API (ends in /api/agent-state). Unset means the
                         platform provides no store, and every factory here returns the
                         in-memory implementation the SDK ships, so the same code runs locally.
    NASIKO_AGENT_TOKEN   this agent's credential. Falls back to MCP_GATEWAY_TOKEN, which holds
                         the same value.

Write guarantee (see NasikoTaskStore): a save that changes ``task.status.state`` is on the
server before ``save()`` returns. Other saves are coalesced to at most one write per
COALESCE_WINDOW_SECONDS per task. A hard crash (SIGKILL, power loss) can therefore lose at
most that window of non-status updates; an orderly exit flushes everything.

Both a2a-sdk majors are supported (0.3.x pydantic tasks and 1.x protobuf tasks). The langgraph
checkpointer needs the optional langgraph-checkpoint package; nothing else does.

This file is vendored: agent images are built from the agent's own directory only, so each
agent keeps a committed copy next to its main module. oss/agents/common is canonical and
oss/agents/common/check_vendored.py fails when a copy drifts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, fields
from typing import Any, Callable, Generic, TypeVar
from urllib.parse import quote, urlsplit

import httpx

logger = logging.getLogger("nasiko_state")

STATE_URL_ENV = "NASIKO_STATE_URL"
AGENT_TOKEN_ENV = "NASIKO_AGENT_TOKEN"
LEGACY_AGENT_TOKEN_ENV = "MCP_GATEWAY_TOKEN"

CLIENT_NAME = "nasiko_state.py/1"

CONNECT_TIMEOUT_SECONDS = 2.0
READ_TIMEOUT_SECONDS = 10.0
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 0.2
MAX_PAGE_SIZE = 100

# The order the registration contract spells its capability lists in.
CAPABILITY_ORDER = ("tasks", "kv")

T = TypeVar("T")


class NasikoStateError(Exception):
    """The state API refused a request or could not be reached.

    ``status`` and ``body`` carry the HTTP answer. Both are None for transport and
    configuration failures, where there was no answer.
    """

    def __init__(self, message: str, *, status: int | None = None, body: str | None = None):
        super().__init__(message)
        self.status = status
        self.body = body


class NasikoStateConflict(NasikoStateError):
    """An ``If-Match`` precondition failed: another writer changed the row first.

    ``current_version`` is the version the server holds, or None if the body did not say.
    """

    def __init__(self, message: str, *, current_version: int | None, body: str | None = None):
        super().__init__(message, status=412, body=body)
        self.current_version = current_version


@dataclass(frozen=True)
class WriteReceipt:
    """What the server answers to a PUT. Task and KV writes share the three fields."""

    version: int
    updated_at: str
    expires_at: str


@dataclass(frozen=True)
class TaskRecord:
    """One stored task. ``body`` is the SDK's serialized Task, opaque to the server."""

    task_id: str
    context_id: str | None
    state: str
    body: Any
    version: int
    updated_at: str
    expires_at: str


@dataclass(frozen=True)
class KVRecord:
    """One stored key. ``value`` is opaque JSON."""

    key: str
    value: Any
    version: int
    updated_at: str
    expires_at: str


@dataclass(frozen=True)
class Page(Generic[T]):
    """One page of a listing. ``next_cursor`` is None on the last page."""

    items: list[T]
    next_cursor: str | None


# --- Operations ---------------------------------------------------------------------------------
#
# Each state API call is described once, as data, and executed by the sync or the async client
# method. That keeps request building, status handling and parsing in a single place.

_UNSET: Any = object()


@dataclass(frozen=True)
class _Operation:
    """One state API call: how to send it and how to read the answer."""

    method: str
    path: str
    parse: Callable[[httpx.Response], Any]
    ok_status: int = 200
    params: Mapping[str, str | int | None] | None = None
    json: Any = _UNSET
    if_match: int | None = None
    # A write names the capability it needs registered; reads leave it None.
    capability: str | None = None
    # What a 404 means. Left unset, a 404 is an error like any other status.
    when_missing: Any = _UNSET

    def request_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"method": self.method, "url": self.path}
        if self.params:
            kwargs["params"] = {key: value for key, value in self.params.items() if value is not None}
        if self.json is not _UNSET:
            kwargs["json"] = self.json
        if self.if_match is not None:
            kwargs["headers"] = {"If-Match": str(self.if_match)}
        return kwargs


def _segment(value: str) -> str:
    """Percent-encode one path segment, so ids containing '/' or ':' stay one segment."""
    return quote(value, safe="")


def _json_body(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError as exc:
        raise NasikoStateError(
            f"state API returned invalid JSON (HTTP {response.status_code})",
            status=response.status_code,
            body=response.text,
        ) from exc


def _record_parser(record_type: type[T]) -> Callable[[httpx.Response], T]:
    def parse(response: httpx.Response) -> T:
        return _record_from_json(record_type, _json_body(response))

    return parse


def _page_parser(record_type: type[T]) -> Callable[[httpx.Response], Page[T]]:
    def parse(response: httpx.Response) -> Page[T]:
        data = _json_body(response)
        try:
            items = [_record_from_json(record_type, item) for item in data["items"]]
            return Page(items=items, next_cursor=data.get("next_cursor"))
        except (KeyError, TypeError, AttributeError) as exc:
            raise NasikoStateError(f"unexpected listing payload from the state API: {data!r:.200}") from exc

    return parse


def _record_from_json(record_type: type[T], data: Any) -> T:
    try:
        return record_type(**{field.name: data[field.name] for field in fields(record_type)})  # type: ignore[call-arg]
    except (KeyError, TypeError) as exc:
        raise NasikoStateError(
            f"unexpected {record_type.__name__} payload from the state API: {data!r:.200}"
        ) from exc


def _register_op(capabilities: Sequence[str], client_name: str) -> _Operation:
    return _Operation(
        "POST",
        "/register",
        parse=lambda response: None,
        ok_status=204,
        json={"capabilities": list(capabilities), "client": client_name},
    )


def _put_task_op(task_id: str, context_id: str | None, state: str, body: Any, if_match: int | None) -> _Operation:
    return _Operation(
        "PUT",
        f"/tasks/{_segment(task_id)}",
        parse=_record_parser(WriteReceipt),
        json={"context_id": context_id, "state": state, "body": body},
        if_match=if_match,
        capability="tasks",
    )


def _get_task_op(task_id: str) -> _Operation:
    return _Operation(
        "GET", f"/tasks/{_segment(task_id)}", parse=_record_parser(TaskRecord), when_missing=None
    )


def _delete_task_op(task_id: str, if_match: int | None) -> _Operation:
    return _Operation(
        "DELETE",
        f"/tasks/{_segment(task_id)}",
        parse=lambda response: True,
        ok_status=204,
        if_match=if_match,
        capability="tasks",
        when_missing=False,
    )


def _list_tasks_op(context_id: str | None, state: str | None, limit: int | None, cursor: str | None) -> _Operation:
    return _Operation(
        "GET",
        "/tasks",
        parse=_page_parser(TaskRecord),
        params={"context_id": context_id, "state": state, "limit": limit, "cursor": cursor},
    )


def _put_kv_op(key: str, value: Any, if_match: int | None) -> _Operation:
    return _Operation(
        "PUT",
        f"/kv/{_segment(key)}",
        parse=_record_parser(WriteReceipt),
        json={"value": value},
        if_match=if_match,
        capability="kv",
    )


def _get_kv_op(key: str) -> _Operation:
    return _Operation("GET", f"/kv/{_segment(key)}", parse=_record_parser(KVRecord), when_missing=None)


def _delete_kv_op(key: str, if_match: int | None) -> _Operation:
    return _Operation(
        "DELETE",
        f"/kv/{_segment(key)}",
        parse=lambda response: True,
        ok_status=204,
        if_match=if_match,
        capability="kv",
        when_missing=False,
    )


def _list_kv_op(prefix: str | None, limit: int | None, cursor: str | None) -> _Operation:
    return _Operation(
        "GET",
        "/kv",
        parse=_page_parser(KVRecord),
        params={"prefix": prefix, "limit": limit, "cursor": cursor},
    )


def _error_from(response: httpx.Response, operation: _Operation) -> NasikoStateError:
    body = response.text
    message = (
        f"state API {operation.method} {operation.path} failed with HTTP {response.status_code}: "
        f"{_problem_text(body)}"
    )
    if response.status_code == 412:
        return NasikoStateConflict(message, current_version=_current_version(body), body=body)
    retry_after = response.headers.get("retry-after")
    if response.status_code == 429 and retry_after:
        message += f" (retry after {retry_after}s)"
    return NasikoStateError(message, status=response.status_code, body=body)


def _problem_text(body: str) -> str:
    """The server's own error text when the body is its JSON envelope, else the raw body."""
    try:
        data = json.loads(body)
    except ValueError:
        return body[:200]
    if isinstance(data, dict):
        return str(data.get("error") or data.get("message") or body)[:200]
    return body[:200]


def _current_version(body: str) -> int | None:
    try:
        version = json.loads(body).get("current_version")
    except (ValueError, AttributeError):
        return None
    return version if isinstance(version, int) else None


def _is_final_attempt(attempt: int) -> bool:
    return attempt >= RETRY_ATTEMPTS


def _request_failed(operation: _Operation, exc: httpx.RequestError) -> NasikoStateError:
    return NasikoStateError(f"state API {operation.method} {operation.path} request failed: {exc!r}")


def _is_retryable(response: httpx.Response) -> bool:
    return response.status_code >= 500


class NasikoStateClient:
    """Typed client for the platform's state API, with a sync and an async method per endpoint.

    Async methods carry an ``a`` prefix (``put_task`` / ``aput_task``), the way langgraph names
    its savers. Failures raise NasikoStateError with the HTTP status and body; nothing falls back
    silently. Connection errors and 5xx answers are retried (RETRY_ATTEMPTS attempts in total,
    exponential backoff) because every call is idempotent; 4xx answers never are.

    The first write of each kind (tasks, kv) registers the agent with the platform, once.
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        client_name: str = CLIENT_NAME,
        transport: Any = None,
        retry_backoff_seconds: float = RETRY_BACKOFF_SECONDS,
    ) -> None:
        parts = urlsplit(base_url)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise NasikoStateError(f"{STATE_URL_ENV} must be an http(s) URL, got {base_url!r}")
        if not token:
            raise NasikoStateError("the state API needs an agent token and none was given")
        self._base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}", "User-Agent": client_name}
        self._client_name = client_name
        self._transport = transport
        self._retry_backoff = retry_backoff_seconds
        self._sync_client: httpx.Client | None = None
        self._async_client: httpx.AsyncClient | None = None
        self._registered: set[str] = set()
        self._register_lock = threading.Lock()
        self._async_register_lock = asyncio.Lock()

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> NasikoStateClient | None:
        """Build a client from the platform's environment, or None when it provides no state API."""
        env = os.environ if env is None else env
        url = env.get(STATE_URL_ENV, "").strip()
        if not url:
            return None
        token = (env.get(AGENT_TOKEN_ENV) or env.get(LEGACY_AGENT_TOKEN_ENV) or "").strip()
        if not token:
            raise NasikoStateError(
                f"{STATE_URL_ENV} is set but neither {AGENT_TOKEN_ENV} nor {LEGACY_AGENT_TOKEN_ENV} "
                "holds the agent credential"
            )
        return cls(url, token)

    def __repr__(self) -> str:
        return f"NasikoStateClient({self._base_url!r})"

    # --- registration ----------------------------------------------------------------------

    def register(self, capabilities: Sequence[str], client_name: str | None = None) -> None:
        """Tell the platform which kinds of state this agent keeps. Writes do this on their own."""
        self._execute(_register_op(capabilities, client_name or self._client_name))
        self._registered.update(capabilities)

    async def aregister(self, capabilities: Sequence[str], client_name: str | None = None) -> None:
        await self._aexecute(_register_op(capabilities, client_name or self._client_name))
        self._registered.update(capabilities)

    # --- tasks -----------------------------------------------------------------------------

    def put_task(
        self, task_id: str, *, context_id: str | None, state: str, body: Any, if_match: int | None = None
    ) -> WriteReceipt:
        return self._run(_put_task_op(task_id, context_id, state, body, if_match))

    async def aput_task(
        self, task_id: str, *, context_id: str | None, state: str, body: Any, if_match: int | None = None
    ) -> WriteReceipt:
        return await self._arun(_put_task_op(task_id, context_id, state, body, if_match))

    def get_task(self, task_id: str) -> TaskRecord | None:
        return self._run(_get_task_op(task_id))

    async def aget_task(self, task_id: str) -> TaskRecord | None:
        return await self._arun(_get_task_op(task_id))

    def delete_task(self, task_id: str, *, if_match: int | None = None) -> bool:
        """Delete a task. False means there was no such task."""
        return self._run(_delete_task_op(task_id, if_match))

    async def adelete_task(self, task_id: str, *, if_match: int | None = None) -> bool:
        return await self._arun(_delete_task_op(task_id, if_match))

    def list_tasks(
        self,
        *,
        context_id: str | None = None,
        state: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> Page[TaskRecord]:
        return self._run(_list_tasks_op(context_id, state, limit, cursor))

    async def alist_tasks(
        self,
        *,
        context_id: str | None = None,
        state: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> Page[TaskRecord]:
        return await self._arun(_list_tasks_op(context_id, state, limit, cursor))

    # --- key-value -------------------------------------------------------------------------

    def put_kv(self, key: str, value: Any, *, if_match: int | None = None) -> WriteReceipt:
        return self._run(_put_kv_op(key, value, if_match))

    async def aput_kv(self, key: str, value: Any, *, if_match: int | None = None) -> WriteReceipt:
        return await self._arun(_put_kv_op(key, value, if_match))

    def get_kv(self, key: str) -> KVRecord | None:
        return self._run(_get_kv_op(key))

    async def aget_kv(self, key: str) -> KVRecord | None:
        return await self._arun(_get_kv_op(key))

    def delete_kv(self, key: str, *, if_match: int | None = None) -> bool:
        """Delete a key. False means there was no such key."""
        return self._run(_delete_kv_op(key, if_match))

    async def adelete_kv(self, key: str, *, if_match: int | None = None) -> bool:
        return await self._arun(_delete_kv_op(key, if_match))

    def list_kv(
        self, *, prefix: str | None = None, limit: int | None = None, cursor: str | None = None
    ) -> Page[KVRecord]:
        return self._run(_list_kv_op(prefix, limit, cursor))

    async def alist_kv(
        self, *, prefix: str | None = None, limit: int | None = None, cursor: str | None = None
    ) -> Page[KVRecord]:
        return await self._arun(_list_kv_op(prefix, limit, cursor))

    # --- lifecycle -------------------------------------------------------------------------

    def close(self) -> None:
        if self._sync_client is not None:
            self._sync_client.close()
            self._sync_client = None

    async def aclose(self) -> None:
        if self._async_client is not None:
            await self._async_client.aclose()
            self._async_client = None
        self.close()

    # --- execution -------------------------------------------------------------------------

    def _run(self, operation: _Operation) -> Any:
        if operation.capability is not None:
            self._ensure_registered(operation.capability)
        return self._execute(operation)

    async def _arun(self, operation: _Operation) -> Any:
        if operation.capability is not None:
            await self._aensure_registered(operation.capability)
        return await self._aexecute(operation)

    def _execute(self, operation: _Operation) -> Any:
        return self._interpret(operation, self._send(operation))

    async def _aexecute(self, operation: _Operation) -> Any:
        return self._interpret(operation, await self._asend(operation))

    def _interpret(self, operation: _Operation, response: httpx.Response) -> Any:
        if response.status_code == 404 and operation.when_missing is not _UNSET:
            return operation.when_missing
        if response.status_code != operation.ok_status:
            raise _error_from(response, operation)
        return operation.parse(response)

    def _send(self, operation: _Operation) -> httpx.Response:
        http = self._sync_http()
        for attempt in range(1, RETRY_ATTEMPTS + 1):
            try:
                response = http.request(**operation.request_kwargs())
            except httpx.TransportError as exc:
                if _is_final_attempt(attempt):
                    raise _request_failed(operation, exc) from exc
            except httpx.RequestError as exc:
                # Not transient (an undecodable answer, a redirect loop): retrying cannot help.
                raise _request_failed(operation, exc) from exc
            else:
                if not _is_retryable(response) or _is_final_attempt(attempt):
                    return response
            time.sleep(self._backoff(attempt))
        raise AssertionError("unreachable: the last attempt returns or raises")

    async def _asend(self, operation: _Operation) -> httpx.Response:
        http = self._async_http()
        for attempt in range(1, RETRY_ATTEMPTS + 1):
            try:
                response = await http.request(**operation.request_kwargs())
            except httpx.TransportError as exc:
                if _is_final_attempt(attempt):
                    raise _request_failed(operation, exc) from exc
            except httpx.RequestError as exc:
                # Not transient (an undecodable answer, a redirect loop): retrying cannot help.
                raise _request_failed(operation, exc) from exc
            else:
                if not _is_retryable(response) or _is_final_attempt(attempt):
                    return response
            await asyncio.sleep(self._backoff(attempt))
        raise AssertionError("unreachable: the last attempt returns or raises")

    def _backoff(self, attempt: int) -> float:
        return self._retry_backoff * 2 ** (attempt - 1)

    def _ensure_registered(self, capability: str) -> None:
        if capability in self._registered:
            return
        with self._register_lock:
            if capability in self._registered:
                return
            self.register(self._capabilities_with(capability))

    async def _aensure_registered(self, capability: str) -> None:
        if capability in self._registered:
            return
        async with self._async_register_lock:
            if capability in self._registered:
                return
            await self.aregister(self._capabilities_with(capability))

    def _capabilities_with(self, capability: str) -> list[str]:
        """Everything registered so far plus this capability, in the contract's order."""
        wanted = self._registered | {capability}
        known = [name for name in CAPABILITY_ORDER if name in wanted]
        return known + sorted(wanted.difference(CAPABILITY_ORDER))

    def _sync_http(self) -> httpx.Client:
        if self._sync_client is None:
            self._sync_client = httpx.Client(
                base_url=self._base_url,
                headers=self._headers,
                timeout=_timeout(),
                transport=self._transport,
            )
        return self._sync_client

    def _async_http(self) -> httpx.AsyncClient:
        if self._async_client is None:
            self._async_client = httpx.AsyncClient(
                base_url=self._base_url,
                headers=self._headers,
                timeout=_timeout(),
                transport=self._transport,
            )
        return self._async_client


def _timeout() -> httpx.Timeout:
    return httpx.Timeout(
        connect=CONNECT_TIMEOUT_SECONDS,
        read=READ_TIMEOUT_SECONDS,
        write=READ_TIMEOUT_SECONDS,
        pool=CONNECT_TIMEOUT_SECONDS,
    )
