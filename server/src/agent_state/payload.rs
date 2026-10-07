//! What is stored for a task body or key-value value: the JSON exactly as the agent sent it,
//! size-checked, then sealed.

use nasiko_secrets::SecretsCrypto;
use serde_json::value::RawValue;
use uuid::Uuid;

use super::error::StateError;

/// A task body or value as received, already within the size cap.
///
/// The server never parses it into a JSON tree: the agent SDK's serialization is the contract,
/// so number precision, key order, escapes and whitespace all come back exactly as sent. The cap
/// is measured on those received bytes, which are also what gets stored.
pub(super) struct BoundedPayload<'a>(&'a str);

impl<'a> BoundedPayload<'a> {
    pub(super) fn new(raw: &'a RawValue, max_bytes: usize) -> Result<Self, StateError> {
        let text = raw.get();
        if text.len() > max_bytes {
            return Err(StateError::PayloadTooLarge(format!(
                "value is {} bytes as sent; the limit is {max_bytes}",
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

    pub(super) fn seal(&self, payload: &BoundedPayload<'_>) -> String {
        self.0.encrypt(payload.0)
    }

    /// The stored JSON text, as it was received. It is checked to still be JSON, so a damaged
    /// row is an error here rather than malformed output.
    pub(super) fn open(&self, sealed: &str) -> Result<Box<RawValue>, StateError> {
        let text = self
            .0
            .decrypt(sealed)
            .map_err(|e| StateError::Internal(format!("stored payload did not decrypt: {e}")))?;
        RawValue::from_string(text)
            .map_err(|e| StateError::Internal(format!("stored payload is not JSON: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(text: &str) -> Box<RawValue> {
        RawValue::from_string(text.to_string()).unwrap()
    }

    #[test]
    fn a_value_at_the_cap_is_accepted_and_one_byte_over_is_not() {
        // A JSON string of n characters is n + 2 bytes (the quotes).
        let at_cap = raw(&format!("\"{}\"", "x".repeat(98)));
        assert!(BoundedPayload::new(&at_cap, 100).is_ok());
        let over_cap = raw(&format!("\"{}\"", "x".repeat(99)));
        assert!(matches!(
            BoundedPayload::new(&over_cap, 100),
            Err(StateError::PayloadTooLarge(_))
        ));
    }

    #[test]
    fn the_cap_counts_the_bytes_as_sent_whitespace_and_escapes_included() {
        let padded = raw("{ \"a\" : 1 }");
        assert!(BoundedPayload::new(&padded, 11).is_ok());
        assert!(BoundedPayload::new(&padded, 10).is_err());

        // `\u00e9` is six bytes on the wire for a character that is two bytes of UTF-8.
        let escaped = raw("\"\\u00e9\"");
        assert!(BoundedPayload::new(&escaped, 8).is_ok());
        assert!(BoundedPayload::new(&escaped, 7).is_err());
    }

    #[test]
    fn the_payload_is_the_text_as_received() {
        let text = "{\"z\":1, \"a\":123456789012345678901234567890,\"e\":\"\\u00e9\"}";
        let value = raw(text);
        assert_eq!(BoundedPayload::new(&value, 1024).unwrap().0, text);
    }
}
