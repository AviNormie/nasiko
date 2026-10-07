//! Who is calling: the agent behind a bearer credential, charged against its request budget.

use std::time::Duration;

use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use sqlx::PgPool;
use uuid::Uuid;

use super::error::StateError;
use crate::rate_limit::RateLimiter;

/// Length of the fixed window the per-agent request budget is counted over, and so also the
/// longest a rejected caller can be told to wait.
const RATE_WINDOW: Duration = Duration::from_secs(60);

/// The agent a request was authenticated as. Only [`authenticate`] puts one on a request.
#[derive(Clone, Copy, Debug)]
pub(super) struct AuthenticatedAgent(pub(super) Uuid);

/// State for [`authenticate`]: the credential store and the per-agent request budget.
#[derive(Clone)]
pub(super) struct AgentAuth {
    db: PgPool,
    limiter: RateLimiter,
}

impl AgentAuth {
    pub(super) fn new(db: PgPool, requests_per_minute: u32) -> Self {
        Self {
            db,
            limiter: RateLimiter::new(requests_per_minute, RATE_WINDOW),
        }
    }
}

/// Middleware for every agent state route.
///
/// The credential is the one the MCP gateway issues, so the two doors cannot disagree about who
/// an agent is: `nasiko_mcp_gateway::agent_tokens::authenticate` also refuses a revoked
/// credential and one whose agent has been deleted. Authentication comes first, so a caller
/// without a valid credential is refused before its body is read and never spends anyone's
/// budget.
pub(super) async fn authenticate(
    State(auth): State<AgentAuth>,
    mut request: Request,
    next: Next,
) -> Response {
    match identify(&auth, request.headers()).await {
        Ok(agent) => {
            request.extensions_mut().insert(agent);
            next.run(request).await
        }
        Err(error) => error.into_response(),
    }
}

async fn identify(auth: &AgentAuth, headers: &HeaderMap) -> Result<AuthenticatedAgent, StateError> {
    let token = bearer_token(headers).ok_or(StateError::Unauthorized)?;
    let agent_id = nasiko_mcp_gateway::agent_tokens::authenticate(&auth.db, token)
        .await
        .map_err(|e| StateError::Internal(format!("agent token lookup failed: {e}")))?
        .ok_or(StateError::Unauthorized)?;
    if !auth.limiter.allow(&agent_id.to_string()) {
        return Err(StateError::RateLimited {
            retry_after_secs: RATE_WINDOW.as_secs(),
        });
    }
    Ok(AuthenticatedAgent(agent_id))
}

/// `Authorization: Bearer <token>`, read exactly as the MCP gateway reads it.
fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

impl<S: Send + Sync> FromRequestParts<S> for AuthenticatedAgent {
    type Rejection = StateError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, StateError> {
        // A handler reached without the middleware must fail closed, not act for nobody.
        parts
            .extensions
            .get::<Self>()
            .copied()
            .ok_or(StateError::Unauthorized)
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn headers_with(authorization: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(authorization).unwrap(),
        );
        headers
    }

    #[test]
    fn a_bearer_token_is_read_and_trimmed() {
        assert_eq!(
            bearer_token(&headers_with("Bearer ngt_abc")),
            Some("ngt_abc")
        );
        assert_eq!(
            bearer_token(&headers_with("Bearer   ngt_abc  ")),
            Some("ngt_abc")
        );
    }

    #[test]
    fn anything_but_a_non_empty_bearer_token_is_no_credential() {
        assert_eq!(bearer_token(&HeaderMap::new()), None);
        for bad in [
            "Bearer ",
            "Bearer    ",
            "Basic dXNlcjpwYXNz",
            "ngt_abc",
            "bearer ngt_abc",
        ] {
            assert_eq!(bearer_token(&headers_with(bad)), None, "{bad:?}");
        }
    }

    #[tokio::test]
    async fn a_request_the_middleware_never_saw_is_unauthorized() {
        let (mut parts, _) = axum::http::Request::new(()).into_parts();
        let result = AuthenticatedAgent::from_request_parts(&mut parts, &()).await;
        assert!(matches!(result, Err(StateError::Unauthorized)));
    }

    #[tokio::test]
    async fn the_identity_the_middleware_attached_is_the_one_extracted() {
        let agent = Uuid::new_v4();
        let (mut parts, _) = axum::http::Request::new(()).into_parts();
        parts.extensions.insert(AuthenticatedAgent(agent));
        let extracted = AuthenticatedAgent::from_request_parts(&mut parts, &())
            .await
            .unwrap();
        assert_eq!(extracted.0, agent);
    }
}
