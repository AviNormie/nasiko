//! What is stored for a task body or key-value value: its JSON text, size-checked, then sealed.

use nasiko_secrets::SecretsCrypto;
use serde_json::Value;
use uuid::Uuid;

use super::error::StateError;

/// A JSON value rendered to the exact text that gets stored, already within the size cap.
///
/// The cap applies to this compact encoding rather than to the request as received, so it means
/// the same thing however the client happened to format its JSON.
pub(super) struct EncodedPayload(String);

impl EncodedPayload {
    pub(super) fn new(value: &Value, max_bytes: usize) -> Result<Self, StateError> {
        let text = serde_json::to_string(value)
            .map_err(|e| StateError::Internal(format!("payload did not encode: {e}")))?;
        if text.len() > max_bytes {
            return Err(StateError::PayloadTooLarge(format!(
                "encoded value is {} bytes; the limit is {max_bytes}",
                text.len()
            )));
        }
        Ok(Self(text))
    }
}

/// Seals and opens one agent's stored payloads (AES-256-GCM).
///
/// The key is the agent-scoped one derived from the platform master key, the same derivation that
/// protects `agents.secrets_env`, so a stolen row of one agent's state is not readable with
/// another agent's key. Build one per request and reuse it across the rows of that request.
pub(super) struct PayloadCipher(SecretsCrypto);

impl PayloadCipher {
    pub(super) fn for_agent(agent_id: Uuid) -> Result<Self, StateError> {
        SecretsCrypto::try_for_agent(agent_id)
            .map(Self)
            .map_err(|e| StateError::Internal(format!("agent key unavailable: {e}")))
    }

    pub(super) fn seal(&self, payload: &EncodedPayload) -> String {
        self.0.encrypt(&payload.0)
    }

    pub(super) fn open(&self, sealed: &str) -> Result<Value, StateError> {
        let text = self
            .0
            .decrypt(sealed)
            .map_err(|e| StateError::Internal(format!("stored payload did not decrypt: {e}")))?;
        serde_json::from_str(&text)
            .map_err(|e| StateError::Internal(format!("stored payload is not JSON: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_value_at_the_cap_is_accepted_and_one_byte_over_is_not() {
        // A JSON string of n characters encodes to n + 2 bytes (the quotes).
        let at_cap = json!("x".repeat(98));
        assert!(EncodedPayload::new(&at_cap, 100).is_ok());
        let over_cap = json!("x".repeat(99));
        assert!(matches!(
            EncodedPayload::new(&over_cap, 100),
            Err(StateError::PayloadTooLarge(_))
        ));
    }

    #[test]
    fn the_cap_counts_the_compact_encoding_not_the_clients_formatting() {
        let value: Value = serde_json::from_str("{\n  \"a\": 1,\n  \"b\": [ 1, 2 ]\n}").unwrap();
        let compact = serde_json::to_string(&value).unwrap();
        assert!(EncodedPayload::new(&value, compact.len()).is_ok());
    }

    #[test]
    fn any_json_value_is_a_payload() {
        for value in [
            json!(null),
            json!(true),
            json!(3.5),
            json!("s"),
            json!([]),
            json!({}),
        ] {
            assert!(EncodedPayload::new(&value, 64).is_ok());
        }
    }
}
