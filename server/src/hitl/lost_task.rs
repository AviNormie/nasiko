//! Recognising that the agent no longer holds the paused task.
//!
//! A paused A2A task lives in the agent's own memory: an `InMemoryTaskStore` loses it on restart,
//! and an answer that reaches a replica that never saw the task finds nothing to continue. The
//! agent says so in one of two ways, and the resume dispatcher treats either as the same fact:
//!
//! * a JSON-RPC `error` with code -32001, A2A's `TaskNotFoundError`, in the reply (an SSE `data:`
//!   frame or a JSON body, at HTTP 200). This is what the Python a2a-sdk sends;
//! * HTTP 404, the status the Rust a2a-server maps the same error to
//!   (`oss/docs/A2A_PROTOCOL.md`, "HTTP Status Code Mapping"). The resume is a POST to the agent's
//!   own JSON-RPC endpoint, which exists for any live A2A agent, so a 404 on it is the agent
//!   answering about the task, not a missing route.
//!
//! Anything else, any other status or any other JSON-RPC code, is not this outcome and keeps its
//! own handling.

use reqwest::StatusCode;

/// JSON-RPC code of A2A's `TaskNotFoundError`.
const TASK_NOT_FOUND_CODE: i64 = -32001;

/// Which of the two ways the agent said its paused task is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LostTaskSignal {
    /// The resume POST was answered with HTTP 404.
    HttpNotFound,
    /// The reply carried a JSON-RPC `error` with code -32001.
    TaskNotFoundError,
}

impl LostTaskSignal {
    /// `Some` when `status` is the agent's HTTP-level "no such task".
    pub(super) fn from_status(status: StatusCode) -> Option<Self> {
        (status == StatusCode::NOT_FOUND).then_some(Self::HttpNotFound)
    }

    /// `Some` when `data`, one SSE `data:` payload or a whole JSON body, is a JSON-RPC error
    /// carrying A2A's `TaskNotFoundError` code. Reads only `error.code`: a -32001 mentioned
    /// anywhere else in a reply (agent text, say) is not the agent reporting anything.
    pub(super) fn from_reply(data: &str) -> Option<Self> {
        let reply: serde_json::Value = serde_json::from_str(data).ok()?;
        let code = reply.pointer("/error/code")?.as_i64()?;
        (code == TASK_NOT_FOUND_CODE).then_some(Self::TaskNotFoundError)
    }

    /// What `resume_last_error` records, so an operator can see which signal classified the row.
    pub(super) fn describe(self) -> &'static str {
        match self {
            Self::HttpNotFound => "agent no longer holds the paused task (HTTP 404)",
            Self::TaskNotFoundError => {
                "agent no longer holds the paused task (A2A TaskNotFoundError, JSON-RPC -32001)"
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_http_404_is_the_agent_reporting_a_missing_task() {
        assert_eq!(
            LostTaskSignal::from_status(StatusCode::NOT_FOUND),
            Some(LostTaskSignal::HttpNotFound)
        );
    }

    #[test]
    fn no_other_http_status_is_a_lost_task() {
        for status in [
            StatusCode::OK,
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::CONFLICT,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            assert_eq!(LostTaskSignal::from_status(status), None, "{status}");
        }
    }

    #[test]
    fn a_json_rpc_task_not_found_error_is_a_lost_task() {
        let reply = json!({
            "jsonrpc": "2.0",
            "id": "req-1",
            "error": { "code": -32001, "message": "Task not found" },
        })
        .to_string();
        assert_eq!(
            LostTaskSignal::from_reply(&reply),
            Some(LostTaskSignal::TaskNotFoundError)
        );
    }

    #[test]
    fn the_error_message_and_id_do_not_matter() {
        // Only the code identifies the error; SDKs word the message differently and the id may be
        // a string, a number or null.
        for reply in [
            json!({ "id": 7, "error": { "code": -32001 } }),
            json!({ "id": null, "error": { "code": -32001, "message": "no such task: t-1" } }),
            json!({ "error": { "code": -32001, "message": "", "data": { "taskId": "t-1" } } }),
        ] {
            assert_eq!(
                LostTaskSignal::from_reply(&reply.to_string()),
                Some(LostTaskSignal::TaskNotFoundError),
                "{reply}"
            );
        }
    }

    #[test]
    fn any_other_json_rpc_error_is_not_a_lost_task() {
        for code in [
            -32700, -32600, -32601, -32602, -32603, -32002, -32006, -32009, 0, 404,
        ] {
            let reply = json!({ "id": 1, "error": { "code": code, "message": "x" } }).to_string();
            assert_eq!(LostTaskSignal::from_reply(&reply), None, "code {code}");
        }
    }

    #[test]
    fn a_reply_that_is_not_an_error_is_not_a_lost_task() {
        for reply in [
            // A task's own status update, even a failed one.
            json!({ "statusUpdate": { "taskId": "t-1", "status": { "state": "TASK_STATE_FAILED" } } }),
            json!({ "result": { "kind": "status-update", "final": true } }),
            // The code appearing somewhere other than `error.code` is not the agent reporting it.
            json!({ "result": { "message": "retry after error -32001" } }),
            json!({ "error": { "message": "Task not found" } }),
            json!({ "error": null }),
        ] {
            assert_eq!(
                LostTaskSignal::from_reply(&reply.to_string()),
                None,
                "{reply}"
            );
        }
    }

    #[test]
    fn a_malformed_code_is_not_a_lost_task() {
        for code in [
            json!("-32001"),
            json!(-32001.5),
            json!(null),
            json!([-32001]),
        ] {
            let reply = json!({ "error": { "code": code } }).to_string();
            assert_eq!(LostTaskSignal::from_reply(&reply), None, "{reply}");
        }
    }

    #[test]
    fn a_reply_that_is_not_json_is_not_a_lost_task() {
        for reply in [
            "",
            "not json",
            "data: {\"error\":{\"code\":-32001}}",
            "{\"error\":",
        ] {
            assert_eq!(LostTaskSignal::from_reply(reply), None, "{reply:?}");
        }
    }

    #[test]
    fn each_signal_describes_itself_distinctly() {
        assert!(LostTaskSignal::HttpNotFound.describe().contains("404"));
        assert!(
            LostTaskSignal::TaskNotFoundError
                .describe()
                .contains("-32001")
        );
    }
}
