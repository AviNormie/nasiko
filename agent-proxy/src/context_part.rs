//! Appending admin-injected context (L1A knowledge today; org policy and L2 beliefs are the
//! next two callers) to an outbound A2A message as its **own part**, rather than splicing it
//! into the text part an agent may parse for the platform's own history-glue marker.
//!
//! `session_history.rs`'s glue convention (`"{history}\n\nCurrent message: {query}"`) is a
//! documented, real pattern this codebase's own `oss/llm-router::latest_user_query` implements:
//! take only the text after `"\n\nCurrent message: "`, treat everything ahead of it as
//! already-handled history to discard. Any agent that follows that same documented convention —
//! which is exactly what it's published for — silently discards whatever text was prepended
//! ahead of that marker. Injected context (L1A facts, org policy, a future L2 belief) is not
//! history; it's meant to inform how the agent answers the *current* turn, every time. Splicing
//! it into the same field the marker convention discards is a category error, not a formatting
//! detail, and it isn't fixable by choosing a different position within that one field: whatever
//! goes ahead of the marker is lost, and whatever goes after it becomes part of what a
//! marker-aware agent treats as the user's literal instruction.
//!
//! The fix is to stop sharing the field. `parts` is already an array for exactly this reason —
//! this platform already sends multi-part messages on every call that carries a file attachment
//! (`file_parts`, threaded through `react-agent`'s `extra_parts`) — so appending a second part is
//! not a new capability, just a new use of one already proven in production. A marker-aware agent
//! still correctly extracts only the query from the one part that has the marker in it (arguably
//! *more* correctly than today, since that part no longer contains anything but the conversation);
//! it gets the injected context too only if it does what the A2A spec already expects of it —
//! consider every part of the message — which is a real protocol-level expectation, not an
//! internal convention specific to this platform.
//!
//! Appended, never inserted at the front: a caller that (incorrectly, but not unheard of for a
//! minimal SDK example) only reads `parts[0]` still gets the unmodified query in that position,
//! same as before this existed — worse for such a caller would be prepending and having it read
//! the injected block instead of the user's message.

use serde_json::Value;

/// Append `text` as a new `{"kind": "text", "text": ...}` part onto `message`'s `parts` array.
///
/// `message` is the A2A `params.message` object (the value at `/params/message` in a
/// `message/send`/`message/stream` JSON-RPC body) — not the whole request, and not one specific
/// part. Returns `None`, leaving `message` untouched, when there's no `parts` array to append to;
/// callers already treat a `None` here as "nothing to inject" and relay the original body
/// unmodified, so this composes with the existing fail-open posture without any special casing.
pub fn append_context_part(message: &mut Value, text: &str) -> Option<()> {
    let parts = message.get_mut("parts")?.as_array_mut()?;
    parts.push(serde_json::json!({ "kind": "text", "text": text }));
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_without_touching_the_existing_part() {
        let mut message = serde_json::json!({
            "parts": [{"kind": "text", "text": "Current message: hello"}],
            "contextId": "ctx-1"
        });
        append_context_part(&mut message, "## Known facts about this agent\nfact one").unwrap();

        let parts = message["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        // The original part is untouched, in place, at index 0 — a caller that only reads
        // `parts[0]` gets exactly what it got before this function was ever called.
        assert_eq!(parts[0]["text"], "Current message: hello");
        assert_eq!(
            parts[1]["text"],
            "## Known facts about this agent\nfact one"
        );
        assert_eq!(parts[1]["kind"], "text");
    }

    #[test]
    fn appended_part_never_contains_the_glue_marker() {
        // The whole point: a marker-aware extractor (`text.find("\n\nCurrent message: ")`,
        // then take the tail) must still find exactly one marker, in the original part only.
        let mut message = serde_json::json!({
            "parts": [{"kind": "text", "text": "Current message: hello"}]
        });
        append_context_part(&mut message, "## Known facts about this agent\nfact one").unwrap();
        let injected_text = message["parts"][1]["text"].as_str().unwrap();
        assert!(!injected_text.contains("Current message: "));
    }

    #[test]
    fn no_parts_array_is_a_clean_miss() {
        let mut message = serde_json::json!({"contextId": "ctx-1"});
        assert!(append_context_part(&mut message, "facts").is_none());
        // Untouched, not partially mutated.
        assert_eq!(message, serde_json::json!({"contextId": "ctx-1"}));
    }

    #[test]
    fn multiple_appends_stack_in_call_order() {
        // The shape L0 (org policy) and L1A both need: each caller appends its own part,
        // independently, with no knowledge of whether the other has already run.
        let mut message = serde_json::json!({
            "parts": [{"kind": "text", "text": "Current message: hello"}]
        });
        append_context_part(&mut message, "## Organization policy\nrule one").unwrap();
        append_context_part(&mut message, "## Known facts about this agent\nfact one").unwrap();

        let parts = message["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0]["text"], "Current message: hello");
        assert_eq!(parts[1]["text"], "## Organization policy\nrule one");
        assert_eq!(
            parts[2]["text"],
            "## Known facts about this agent\nfact one"
        );
    }
}
