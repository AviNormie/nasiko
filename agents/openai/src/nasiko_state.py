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
import atexit
import base64
import json
import logging
import os
import threading
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, fields
from typing import Any, Generic, TypeVar
from urllib.parse import quote, urlsplit

import httpx
from a2a.server.tasks import InMemoryTaskStore, TaskStore
from a2a.types import Task

try:
    from a2a.types import a2a_pb2 as _a2a_pb2  # a2a-sdk 1.x: tasks are protobuf messages
except ImportError:
    _a2a_pb2 = None  # a2a-sdk 0.3.x: tasks are pydantic models

try:
    from langgraph.checkpoint.base import (
        WRITES_IDX_MAP,
        BaseCheckpointSaver,
        CheckpointTuple,
        get_checkpoint_metadata,
    )

    _LANGGRAPH_AVAILABLE = True
except ImportError:
    # langgraph is optional: only agents that checkpoint with it need the package.
    BaseCheckpointSaver = object  # type: ignore[assignment,misc]
    _LANGGRAPH_AVAILABLE = False

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
DEFAULT_PAGE_SIZE = 50

# Saves that do not change a task's state are written at most once per window per task.
COALESCE_WINDOW_SECONDS = 0.5
# Exiting with the platform unreachable must not hang for every pending task.
EXIT_FLUSH_BUDGET_SECONDS = 10.0
# Bound on tasks whose write state is remembered; forgetting one only costs it one extra write.
MAX_TRACKED_TASKS = 4096

# The state column stored with each task uses one vocabulary under both SDK majors, the A2A 0.3
# wire spelling: submitted, working, input-required, auth-required, completed, canceled, failed,
# rejected, unknown. 1.x names (TASK_STATE_INPUT_REQUIRED) are mapped onto it.
TERMINAL_STATES = frozenset({"completed", "canceled", "failed", "rejected"})

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


class NasikoStateMalformedRow(NasikoStateError):
    """A stored row cannot be read back as what it claims to be.

    Raised for a task written by the other a2a-sdk major (or not by this module at all), and for a
    damaged record. Never answered with a half-decoded object.
    """


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


def _percent_encode(value: str) -> str:
    """Escape everything but unreserved characters, so '/', ':' and '%' in an id stay inert.

    Used for URL path segments and for the components of composite keys alike.
    """
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
        values = {field.name: data[field.name] for field in fields(record_type)}
        return record_type(**values)  # type: ignore[call-arg]
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


def _put_task_op(
    task_id: str, context_id: str | None, state: str, body: Any, if_match: int | None
) -> _Operation:
    return _Operation(
        "PUT",
        f"/tasks/{_percent_encode(task_id)}",
        parse=_record_parser(WriteReceipt),
        json={"context_id": context_id, "state": state, "body": body},
        if_match=if_match,
        capability="tasks",
    )


def _get_task_op(task_id: str) -> _Operation:
    return _Operation(
        "GET", f"/tasks/{_percent_encode(task_id)}", parse=_record_parser(TaskRecord), when_missing=None
    )


def _delete_task_op(task_id: str, if_match: int | None) -> _Operation:
    return _Operation(
        "DELETE",
        f"/tasks/{_percent_encode(task_id)}",
        parse=lambda response: True,
        ok_status=204,
        if_match=if_match,
        capability="tasks",
        when_missing=False,
    )


def _list_tasks_op(
    context_id: str | None, state: str | None, limit: int | None, cursor: str | None
) -> _Operation:
    return _Operation(
        "GET",
        "/tasks",
        parse=_page_parser(TaskRecord),
        params={"context_id": context_id, "state": state, "limit": limit, "cursor": cursor},
    )


def _put_kv_op(key: str, value: Any, if_match: int | None) -> _Operation:
    return _Operation(
        "PUT",
        f"/kv/{_percent_encode(key)}",
        parse=_record_parser(WriteReceipt),
        json={"value": value},
        if_match=if_match,
        capability="kv",
    )


def _get_kv_op(key: str) -> _Operation:
    return _Operation("GET", f"/kv/{_percent_encode(key)}", parse=_record_parser(KVRecord), when_missing=None)


def _delete_kv_op(key: str, if_match: int | None) -> _Operation:
    return _Operation(
        "DELETE",
        f"/kv/{_percent_encode(key)}",
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


# --- a2a-sdk major-version adapter --------------------------------------------------------------
#
# 0.3.x tasks are pydantic models; 1.x tasks are protobuf messages with no model_dump. Everything
# the store needs from a task goes through these names, so the store itself is version-blind.
#
# The two majors serialize a task differently, and a body written by one can parse under the other
# into a task with silently wrong fields (protobuf drops what it does not know). Every stored body
# is therefore tagged with the format that wrote it, and a foreign tag is refused outright.

TASK_FORMAT_A2A_0_3 = "a2a-0.3"
TASK_FORMAT_A2A_1 = "a2a-1"

if _a2a_pb2 is None:
    TASK_FORMAT = TASK_FORMAT_A2A_0_3
    _DECODE_ERRORS: tuple[type[BaseException], ...] = (ValueError, TypeError)

    def _encode_task(task: Task) -> dict[str, Any]:
        return task.model_dump(mode="json", exclude_none=True)

    def _decode_task(body: Any) -> Task:
        return Task.model_validate(body)

    def _state_name(task: Task) -> str:
        return task.status.state.value

else:
    from google.protobuf.json_format import MessageToDict, ParseDict, ParseError
    from a2a.utils.errors import UnsupportedOperationError

    TASK_FORMAT = TASK_FORMAT_A2A_1
    _DECODE_ERRORS = (ParseError, ValueError, TypeError, AttributeError)

    def _encode_task(task: Task) -> dict[str, Any]:
        return MessageToDict(task)

    def _decode_task(body: Any) -> Task:
        # Strict: an unknown field means the body is not what its tag claims, and protobuf would
        # otherwise drop it (and any unknown enum value) without a word.
        return ParseDict(body, Task())

    def _state_name(task: Task) -> str:
        return _proto_state_name(task.status.state)

    def _proto_state_name(state: int) -> str:
        """'TASK_STATE_INPUT_REQUIRED' -> 'input-required', the 0.3 wire spelling."""
        name = _a2a_pb2.TaskState.Name(state).removeprefix("TASK_STATE_").lower().replace("_", "-")
        return "unknown" if name == "unspecified" else name

    def _list_arguments(params: Any) -> dict[str, Any]:
        """Map a ListTasksRequest onto the state API's listing filters."""
        if params.HasField("status_timestamp_after"):
            raise UnsupportedOperationError(
                message="tasks/list cannot filter by status_timestamp_after on the platform state store"
            )
        return {
            "context_id": params.context_id or None,
            "state": _proto_state_name(params.status) if params.status else None,
            "limit": params.page_size or DEFAULT_PAGE_SIZE,
            "cursor": params.page_token or None,
        }

    def _list_response(tasks: list[Task], page: Page[TaskRecord], limit: int) -> Any:
        # The state API reports no totals, so total_size is the size of this page.
        return _a2a_pb2.ListTasksResponse(
            tasks=tasks, next_page_token=page.next_cursor or "", page_size=limit, total_size=len(tasks)
        )


def _stored_body(task: Task) -> dict[str, Any]:
    """The body written to the state API: the serialized task, tagged with its format."""
    return {"format": TASK_FORMAT, "task": _encode_task(task)}


def _decode_stored_task(body: Any, task_id: str) -> Task:
    stored_format = body.get("format") if isinstance(body, dict) else None
    if stored_format != TASK_FORMAT or "task" not in body:
        raise NasikoStateMalformedRow(
            f"stored task {task_id!r} is in format {stored_format!r}, and the installed a2a-sdk reads "
            f"{TASK_FORMAT!r} only"
        )
    try:
        task = _decode_task(body["task"])
    except _DECODE_ERRORS as exc:
        raise NasikoStateMalformedRow(
            f"stored task {task_id!r} cannot be decoded by the installed a2a-sdk: {exc}"
        ) from exc
    # protobuf parsing turns {} into an empty Task rather than failing, so check the identity too.
    if task.id != task_id:
        raise NasikoStateMalformedRow(f"stored task {task_id!r} holds a body for task {task.id!r}")
    return task


# --- task store ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Snapshot:
    """A task as it stood when save() was called.

    The SDK mutates its Task in place after saving it, so the store keeps this serialized copy
    and never the live object.
    """

    task_id: str
    context_id: str | None
    state: str
    body: dict[str, Any]


def _snapshot(task: Task) -> _Snapshot:
    return _Snapshot(task.id, task.context_id or None, _state_name(task), _stored_body(task))


class _TaskSlot:
    """Write-coalescing bookkeeping for one task."""

    def __init__(self) -> None:
        # The newest snapshot the server has not confirmed yet.
        self.pending: _Snapshot | None = None
        # State of the last snapshot the server confirmed; None until the first write lands.
        self.written_state: str | None = None
        self.last_write_started = float("-inf")
        self.flusher: asyncio.Task[None] | None = None
        # One write per task at a time, so an older snapshot cannot land after a newer one.
        self.lock = asyncio.Lock()

    def is_idle(self) -> bool:
        return self.pending is None and self.flusher is None and not self.lock.locked()


class NasikoTaskStore(TaskStore):
    """An a2a-sdk TaskStore that keeps tasks in the platform's state API.

    Writes, by what changed:
      - A save that changes ``task.status.state`` (the first save of a task, input-required,
        every terminal state) is on the server before ``save()`` returns.
      - Any other save (artifact chunks, message history) is coalesced: the newest snapshot is
        written at most once per ``coalesce_window_seconds`` per task, and always flushed when the
        task changes state, on ``aclose()`` and at interpreter exit.
      - Guarantee boundary: a hard crash (SIGKILL, power loss) can lose at most one window,
        0.5 s by default, of non-status updates. State changes are never lost once save() returned.

    Reads see this process's own unwritten snapshot, so a task is never older than the last save
    that was made here. ``list`` is served by the server and can lag by one window.

    Tasks are scoped to the agent, not to an end user: the SDK's per-user owner resolution does
    not apply. A task is expected to be handled by one replica at a time; concurrent writers to
    the same task are last-writer-wins.
    """

    def __init__(
        self, client: NasikoStateClient, *, coalesce_window_seconds: float = COALESCE_WINDOW_SECONDS
    ) -> None:
        self._client = client
        self._window = coalesce_window_seconds
        self._slots: OrderedDict[str, _TaskSlot] = OrderedDict()
        atexit.register(self.flush_sync)

    async def save(self, task: Task, context: Any = None) -> None:
        snapshot = _snapshot(task)
        slot = self._slot(snapshot.task_id)
        slot.pending = snapshot
        if snapshot.state != slot.written_state:
            await self._write_pending(slot)
        else:
            self._schedule_flush(slot)

    async def get(self, task_id: str, context: Any = None) -> Task | None:
        slot = self._slots.get(task_id)
        if slot is not None and slot.pending is not None:
            return _decode_stored_task(slot.pending.body, task_id)
        record = await self._client.aget_task(task_id)
        return None if record is None else _decode_stored_task(record.body, task_id)

    async def delete(self, task_id: str, context: Any = None) -> None:
        slot = self._slot(task_id)
        async with slot.lock:
            slot.pending = None  # an unwritten snapshot must not bring the task back
            await self._client.adelete_task(task_id)
        self._forget(task_id, slot)

    if _a2a_pb2 is not None:
        # a2a-sdk 1.x added tasks/list to the TaskStore interface; 0.3.x has no such method.

        async def list(self, params: Any, context: Any = None) -> Any:
            arguments = _list_arguments(params)
            page = await self._client.alist_tasks(**arguments)
            tasks = [_decode_stored_task(record.body, record.task_id) for record in page.items]
            return _list_response(tasks, page, arguments["limit"])

    async def aclose(self) -> None:
        """Write everything pending, stop the background flushers and close the HTTP client."""
        atexit.unregister(self.flush_sync)
        flushers = [slot.flusher for slot in self._slots.values() if slot.flusher is not None]
        for flusher in flushers:
            flusher.cancel()
        await asyncio.gather(*flushers, return_exceptions=True)
        pending = [slot for slot in list(self._slots.values()) if slot.pending is not None]
        outcomes = await asyncio.gather(
            *(self._write_pending(slot) for slot in pending), return_exceptions=True
        )
        await self._client.aclose()
        failures = [outcome for outcome in outcomes if isinstance(outcome, BaseException)]
        for failure in failures[1:]:
            logger.error("a pending task write could not be flushed on close: %s", failure)
        if failures:
            raise failures[0]

    def flush_sync(self) -> None:
        """Write every pending snapshot, blocking. Registered with atexit, when no event loop is left."""
        deadline = time.monotonic() + EXIT_FLUSH_BUDGET_SECONDS
        for slot in list(self._slots.values()):
            snapshot = slot.pending
            if snapshot is None:
                continue
            if time.monotonic() >= deadline:
                logger.error(
                    "exit flush budget spent; task %s and any after it were not written", snapshot.task_id
                )
                return
            try:
                self._client.put_task(
                    snapshot.task_id, context_id=snapshot.context_id, state=snapshot.state, body=snapshot.body
                )
            except NasikoStateError as exc:
                logger.error("exit flush of task %s failed: %s", snapshot.task_id, exc)
            else:
                self._confirm(slot, snapshot)

    # --- coalescing ------------------------------------------------------------------------

    async def _write_pending(self, slot: _TaskSlot) -> None:
        async with slot.lock:
            snapshot = slot.pending
            if snapshot is None:
                return  # a newer write already carried it
            slot.last_write_started = time.monotonic()
            await self._client.aput_task(
                snapshot.task_id, context_id=snapshot.context_id, state=snapshot.state, body=snapshot.body
            )
            self._confirm(slot, snapshot)

    def _confirm(self, slot: _TaskSlot, snapshot: _Snapshot) -> None:
        slot.written_state = snapshot.state
        if slot.pending is not snapshot:
            return  # a newer snapshot arrived while this one was in flight; it is still owed
        slot.pending = None
        if snapshot.state in TERMINAL_STATES:
            self._forget(snapshot.task_id, slot)

    def _schedule_flush(self, slot: _TaskSlot) -> None:
        if slot.flusher is None:
            slot.flusher = asyncio.get_running_loop().create_task(self._flush_when_due(slot))

    async def _flush_when_due(self, slot: _TaskSlot) -> None:
        try:
            while slot.pending is not None:
                await asyncio.sleep(self._seconds_until_due(slot))
                await self._write_pending(slot)
        except NasikoStateError as exc:
            # No caller awaits this task to hand the error to. The snapshot stays pending, so the
            # next save, aclose() or the exit flush retries it.
            logger.error("deferred task write failed, will retry on the next save or at exit: %s", exc)
        finally:
            slot.flusher = None

    def _seconds_until_due(self, slot: _TaskSlot) -> float:
        return max(0.0, slot.last_write_started + self._window - time.monotonic())

    # --- slot bookkeeping ------------------------------------------------------------------

    def _slot(self, task_id: str) -> _TaskSlot:
        slot = self._slots.get(task_id)
        if slot is not None:
            self._slots.move_to_end(task_id)
            return slot
        slot = self._slots[task_id] = _TaskSlot()
        self._evict_idle_slots()
        return slot

    def _forget(self, task_id: str, slot: _TaskSlot) -> None:
        if self._slots.get(task_id) is slot:
            del self._slots[task_id]

    def _evict_idle_slots(self) -> None:
        """Keep memory bounded: drop the least recently used slots that owe the server nothing.

        The newest slot is the caller's and is never a candidate.
        """
        excess = len(self._slots) - MAX_TRACKED_TASKS
        for task_id in list(self._slots)[:-1]:
            if excess <= 0:
                return
            if self._slots[task_id].is_idle():
                del self._slots[task_id]
                excess -= 1


def make_task_store() -> TaskStore:
    """The task store an agent hands to its request handler.

    The platform's durable store when NASIKO_STATE_URL is set, otherwise the SDK's in-memory
    store, built exactly as an agent would build it by hand. Nothing contacts the platform
    until the first task is saved.
    """
    client = NasikoStateClient.from_env()
    if client is None:
        return InMemoryTaskStore()
    logger.info("task state is kept in the platform state API: %r", client)
    return NasikoTaskStore(client)


# --- key-value ----------------------------------------------------------------------------------


class NasikoKV:
    """Key-value access to the platform's state API, scoped to this agent. Values are opaque JSON.

    ``list`` follows the server's cursors, so callers see every key under a prefix. Like the client
    it wraps, each operation has a sync form and an ``a``-prefixed async form.
    """

    def __init__(self, client: NasikoStateClient) -> None:
        self._client = client

    def get(self, key: str) -> KVRecord | None:
        return self._client.get_kv(key)

    async def aget(self, key: str) -> KVRecord | None:
        return await self._client.aget_kv(key)

    def put(self, key: str, value: Any, *, if_match: int | None = None) -> WriteReceipt:
        return self._client.put_kv(key, value, if_match=if_match)

    async def aput(self, key: str, value: Any, *, if_match: int | None = None) -> WriteReceipt:
        return await self._client.aput_kv(key, value, if_match=if_match)

    def delete(self, key: str, *, if_match: int | None = None) -> bool:
        """Delete a key. False means there was no such key."""
        return self._client.delete_kv(key, if_match=if_match)

    async def adelete(self, key: str, *, if_match: int | None = None) -> bool:
        return await self._client.adelete_kv(key, if_match=if_match)

    def list(self, prefix: str = "") -> Iterator[KVRecord]:
        """Every record whose key starts with ``prefix``, in the server's order."""
        cursor: str | None = None
        while True:
            page = self._client.list_kv(prefix=prefix or None, limit=MAX_PAGE_SIZE, cursor=cursor)
            yield from page.items
            if page.next_cursor is None:
                return
            cursor = page.next_cursor

    async def alist(self, prefix: str = "") -> AsyncIterator[KVRecord]:
        cursor: str | None = None
        while True:
            page = await self._client.alist_kv(prefix=prefix or None, limit=MAX_PAGE_SIZE, cursor=cursor)
            for record in page.items:
                yield record
            if page.next_cursor is None:
                return
            cursor = page.next_cursor


# --- langgraph checkpointer ---------------------------------------------------------------------

CHECKPOINT_FAMILY = "lg"
HEAD_FAMILY = "lgh"
WRITES_FAMILY = "lgw"


def _key(family: str, *parts: str) -> str:
    return ":".join([family, *(_percent_encode(part) for part in parts)])


def _prefix(family: str, *parts: str) -> str:
    """Prefix matching every key of `family` that starts with these leading components."""
    return _key(family, *parts) + ":"


def _thread_and_namespace(config: Mapping[str, Any]) -> tuple[str, str]:
    configurable = config["configurable"]
    return configurable["thread_id"], configurable.get("checkpoint_ns", "")


def _scope(config: Mapping[str, Any] | None) -> tuple[str, ...]:
    """The leading key components a listing is narrowed to: nothing, a thread, or a thread and namespace."""
    if not config:
        return ()
    configurable = config["configurable"]
    if configurable.get("checkpoint_ns") is None:
        return (configurable["thread_id"],)
    return (configurable["thread_id"], configurable["checkpoint_ns"])


@dataclass(frozen=True)
class _PlannedWrite:
    key: str
    record: dict[str, Any]
    # Regular writes keep the first writer's value; writes to special channels are upserts.
    insert_only: bool


class NasikoCheckpointSaver(BaseCheckpointSaver):  # type: ignore[misc]
    """A langgraph checkpointer that keeps checkpoints in the platform's key-value state.

    It implements the sync methods (``graph.stream`` and ``graph.invoke``) and their async twins
    (``astream``, ``ainvoke``). The optional ``copy_thread``, ``prune`` and ``delete_for_runs``
    are left to the base class, which refuses them.

    Layout. Every component is percent-encoded, so ':' only ever separates components, and every
    langgraph object is written by the saver's own serde and carried as a base64 string in a JSON
    record. Pickle is never written or read.

      lg:{thread}:{ns}:{checkpoint}  the whole checkpoint with its metadata and parent id. Values
                                     are stored in full rather than shared between checkpoints, so
                                     one record answers one get_tuple.
      lgh:{thread}:{ns}              the id of the newest checkpoint. The key-value API has no
                                     "latest" query, and scanning every checkpoint to find the
                                     newest would cost a call per hundred of them.
      lgw:{thread}:{ns}:{checkpoint}:{task}:{idx}
                                     the writes one task made against a checkpoint. All regular
                                     writes of one put_writes call share one record, keyed by the
                                     first one's index, so a crash cannot leave a task with only
                                     some of its writes; each write to a special channel (error,
                                     interrupt, resume, scheduled) has its own record at its
                                     negative index.

    A checkpoint is written before the head that points at it, so a crash can only leave the head
    one checkpoint behind, which resumes cleanly: that step's tasks have their writes saved and are
    not run again. State expires with the platform's retention, counted from the last write.
    """

    def __init__(self, kv: NasikoKV, *, serde: Any = None) -> None:
        if not _LANGGRAPH_AVAILABLE:
            raise ImportError("NasikoCheckpointSaver needs the langgraph-checkpoint package")
        super().__init__(serde=serde)
        self._kv = kv

    # --- reading ---------------------------------------------------------------------------

    def get_tuple(self, config: Any) -> Any:
        thread_id, namespace = _thread_and_namespace(config)
        checkpoint_id = config["configurable"].get("checkpoint_id")
        if checkpoint_id is None:
            head = self._kv.get(_key(HEAD_FAMILY, thread_id, namespace))
            if head is None:
                return None
            checkpoint_id = head.value["checkpoint_id"]
        record = self._kv.get(_key(CHECKPOINT_FAMILY, thread_id, namespace, checkpoint_id))
        if record is None:
            return None
        prefix = _prefix(WRITES_FAMILY, thread_id, namespace, checkpoint_id)
        writes = [write.value for write in self._kv.list(prefix)]
        explicit = config if config["configurable"].get("checkpoint_id") else None
        return self._tuple(record.value, writes, config=explicit)

    async def aget_tuple(self, config: Any) -> Any:
        thread_id, namespace = _thread_and_namespace(config)
        checkpoint_id = config["configurable"].get("checkpoint_id")
        if checkpoint_id is None:
            head = await self._kv.aget(_key(HEAD_FAMILY, thread_id, namespace))
            if head is None:
                return None
            checkpoint_id = head.value["checkpoint_id"]
        record = await self._kv.aget(_key(CHECKPOINT_FAMILY, thread_id, namespace, checkpoint_id))
        if record is None:
            return None
        prefix = _prefix(WRITES_FAMILY, thread_id, namespace, checkpoint_id)
        writes = [write.value async for write in self._kv.alist(prefix)]
        explicit = config if config["configurable"].get("checkpoint_id") else None
        return self._tuple(record.value, writes, config=explicit)

    def list(
        self,
        config: Any,
        *,
        filter: dict[str, Any] | None = None,
        before: Any = None,
        limit: int | None = None,
    ) -> Iterator[Any]:
        scope = _scope(config)
        checkpoints = [record.value for record in self._kv.list(_prefix(CHECKPOINT_FAMILY, *scope))]
        selected = self._select(checkpoints, config, filter, before, limit)
        writes = self._writes_by_checkpoint(list(self._kv.list(_prefix(WRITES_FAMILY, *scope))))
        for record in selected:
            yield self._tuple(record, writes.get(_checkpoint_identity(record), []))

    async def alist(
        self,
        config: Any,
        *,
        filter: dict[str, Any] | None = None,
        before: Any = None,
        limit: int | None = None,
    ) -> AsyncIterator[Any]:
        scope = _scope(config)
        checkpoints = [record.value async for record in self._kv.alist(_prefix(CHECKPOINT_FAMILY, *scope))]
        selected = self._select(checkpoints, config, filter, before, limit)
        write_records = [record async for record in self._kv.alist(_prefix(WRITES_FAMILY, *scope))]
        writes = self._writes_by_checkpoint(write_records)
        for record in selected:
            yield self._tuple(record, writes.get(_checkpoint_identity(record), []))

    # --- writing ---------------------------------------------------------------------------

    def put(self, config: Any, checkpoint: Any, metadata: Any, new_versions: Any) -> Any:
        # new_versions is unused: langgraph needs it to share channel blobs between checkpoints,
        # and this saver stores each checkpoint whole.
        thread_id, namespace = _thread_and_namespace(config)
        self._kv.put(
            _key(CHECKPOINT_FAMILY, thread_id, namespace, checkpoint["id"]),
            self._checkpoint_record(config, checkpoint, metadata),
        )
        self._kv.put(_key(HEAD_FAMILY, thread_id, namespace), {"checkpoint_id": checkpoint["id"]})
        return _checkpoint_config(thread_id, namespace, checkpoint["id"])

    async def aput(self, config: Any, checkpoint: Any, metadata: Any, new_versions: Any) -> Any:
        thread_id, namespace = _thread_and_namespace(config)
        await self._kv.aput(
            _key(CHECKPOINT_FAMILY, thread_id, namespace, checkpoint["id"]),
            self._checkpoint_record(config, checkpoint, metadata),
        )
        await self._kv.aput(_key(HEAD_FAMILY, thread_id, namespace), {"checkpoint_id": checkpoint["id"]})
        return _checkpoint_config(thread_id, namespace, checkpoint["id"])

    def put_writes(
        self, config: Any, writes: Sequence[tuple[str, Any]], task_id: str, task_path: str = ""
    ) -> None:
        for planned in self._plan_writes(config, writes, task_id, task_path):
            if planned.insert_only and self._kv.get(planned.key) is not None:
                continue
            self._kv.put(planned.key, planned.record)

    async def aput_writes(
        self, config: Any, writes: Sequence[tuple[str, Any]], task_id: str, task_path: str = ""
    ) -> None:
        for planned in self._plan_writes(config, writes, task_id, task_path):
            if planned.insert_only and await self._kv.aget(planned.key) is not None:
                continue
            await self._kv.aput(planned.key, planned.record)

    def delete_thread(self, thread_id: str) -> None:
        # Heads first: a half-deleted thread then reads as empty rather than pointing at nothing.
        for family in (HEAD_FAMILY, CHECKPOINT_FAMILY, WRITES_FAMILY):
            for record in list(self._kv.list(_prefix(family, thread_id))):
                self._kv.delete(record.key)

    async def adelete_thread(self, thread_id: str) -> None:
        for family in (HEAD_FAMILY, CHECKPOINT_FAMILY, WRITES_FAMILY):
            records = [record async for record in self._kv.alist(_prefix(family, thread_id))]
            for record in records:
                await self._kv.adelete(record.key)

    # --- records ---------------------------------------------------------------------------

    def _encode(self, value: Any) -> dict[str, str]:
        kind, data = self.serde.dumps_typed(value)
        if kind == "pickle":
            raise NasikoStateError("refusing to store a pickled value in the platform state")
        return {"type": kind, "data": base64.b64encode(data).decode("ascii")}

    def _decode(self, encoded: Mapping[str, str]) -> Any:
        if encoded["type"] == "pickle":
            raise NasikoStateError("refusing to load a pickled value from the platform state")
        return self.serde.loads_typed((encoded["type"], base64.b64decode(encoded["data"])))

    def _checkpoint_record(self, config: Any, checkpoint: Any, metadata: Any) -> dict[str, Any]:
        thread_id, namespace = _thread_and_namespace(config)
        return {
            "thread_id": thread_id,
            "checkpoint_ns": namespace,
            "checkpoint_id": checkpoint["id"],
            "parent_checkpoint_id": config["configurable"].get("checkpoint_id"),
            "checkpoint": self._encode(checkpoint),
            "metadata": self._encode(get_checkpoint_metadata(config, metadata)),
        }

    def _tuple(
        self, record: dict[str, Any], write_records: list[dict[str, Any]], *, config: Any = None
    ) -> Any:
        thread_id, namespace = record["thread_id"], record["checkpoint_ns"]
        parent_id = record["parent_checkpoint_id"]
        return CheckpointTuple(
            config=config or _checkpoint_config(thread_id, namespace, record["checkpoint_id"]),
            checkpoint=self._decode(record["checkpoint"]),
            metadata=self._decode(record["metadata"]),
            parent_config=_checkpoint_config(thread_id, namespace, parent_id) if parent_id else None,
            pending_writes=self._pending_writes(write_records),
        )

    def _pending_writes(self, write_records: list[dict[str, Any]]) -> list[tuple[str, str, Any]]:
        """Flatten write records into langgraph's (task, channel, value), ordered by task then index."""
        entries = []
        for record in write_records:
            for write in record["writes"]:
                entries.append((record["task_id"], write["idx"], write["channel"], write["value"]))
        entries.sort(key=lambda entry: (entry[0], entry[1]))
        return [(task_id, channel, self._decode(value)) for task_id, _, channel, value in entries]

    def _plan_writes(
        self, config: Any, writes: Sequence[tuple[str, Any]], task_id: str, task_path: str
    ) -> list[_PlannedWrite]:
        thread_id, namespace = _thread_and_namespace(config)
        checkpoint_id = config["configurable"]["checkpoint_id"]
        regular: list[tuple[int, str, Any]] = []
        special: dict[int, tuple[int, str, Any]] = {}
        for position, (channel, value) in enumerate(writes):
            if channel in WRITES_IDX_MAP:
                special[WRITES_IDX_MAP[channel]] = (WRITES_IDX_MAP[channel], channel, value)
            else:
                regular.append((position, channel, value))

        def planned(entries: list[tuple[int, str, Any]], *, insert_only: bool) -> _PlannedWrite:
            record = {
                "thread_id": thread_id,
                "checkpoint_ns": namespace,
                "checkpoint_id": checkpoint_id,
                "task_id": task_id,
                "task_path": task_path,
                "writes": [
                    {"idx": idx, "channel": channel, "value": self._encode(value)}
                    for idx, channel, value in entries
                ],
            }
            key = _key(WRITES_FAMILY, thread_id, namespace, checkpoint_id, task_id, str(entries[0][0]))
            return _PlannedWrite(key, record, insert_only)

        plan = [planned(regular, insert_only=True)] if regular else []
        return plan + [planned([entry], insert_only=False) for entry in special.values()]

    def _writes_by_checkpoint(
        self, write_records: list[KVRecord]
    ) -> dict[tuple[str, str, str], list[dict[str, Any]]]:
        grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
        for item in write_records:
            grouped.setdefault(_checkpoint_identity(item.value), []).append(item.value)
        return grouped

    def _select(
        self,
        records: list[dict[str, Any]],
        config: Any,
        filter: dict[str, Any] | None,
        before: Any,
        limit: int | None,
    ) -> list[dict[str, Any]]:
        """The checkpoints list() yields: newest first, narrowed by id, `before`, metadata and `limit`."""
        wanted_id = config["configurable"].get("checkpoint_id") if config else None
        before_id = before["configurable"].get("checkpoint_id") if before else None
        selected = []
        for record in sorted(records, key=lambda r: r["checkpoint_id"], reverse=True):
            if wanted_id and record["checkpoint_id"] != wanted_id:
                continue
            if before_id and record["checkpoint_id"] >= before_id:
                continue
            if filter and not self._matches(record, filter):
                continue
            selected.append(record)
        return selected if limit is None else selected[: max(limit, 0)]

    def _matches(self, record: dict[str, Any], filter: dict[str, Any]) -> bool:
        metadata = self._decode(record["metadata"])
        return all(metadata.get(key) == value for key, value in filter.items())


def _checkpoint_config(thread_id: str, namespace: str, checkpoint_id: str) -> dict[str, Any]:
    return {
        "configurable": {"thread_id": thread_id, "checkpoint_ns": namespace, "checkpoint_id": checkpoint_id}
    }


def _checkpoint_identity(record: Mapping[str, Any]) -> tuple[str, str, str]:
    return record["thread_id"], record["checkpoint_ns"], record["checkpoint_id"]


def make_checkpointer() -> Any:
    """The checkpointer a langgraph agent compiles its graph with.

    The platform's durable one when NASIKO_STATE_URL is set, otherwise langgraph's own
    ``MemorySaver``, built exactly as an agent would build it by hand.
    """
    client = NasikoStateClient.from_env()
    if client is None:
        from langgraph.checkpoint.memory import MemorySaver

        return MemorySaver()
    logger.info("langgraph checkpoints are kept in the platform state API: %r", client)
    return NasikoCheckpointSaver(NasikoKV(client))
