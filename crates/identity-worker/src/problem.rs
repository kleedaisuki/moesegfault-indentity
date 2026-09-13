//! RFC 9457 Problem Details 响应。/ RFC 9457 Problem Details responses.

use serde::Serialize;
use worker::{Headers, Response, Result};

const TYPE_BASE: &str = "https://identity.moesegfault.dev/problems/";

/// 稳定、机器可读的错误正文。/ Stable, machine-readable error body.
#[derive(Debug, Serialize)]
pub struct Problem<'a> {
    #[serde(rename = "type")]
    pub type_uri: String,
    pub title: &'a str,
    pub status: u16,
    pub error_code: &'a str,
    pub correlation_id: &'a str,
}

/// 创建带 correlation ID 的 Problem Details。
/// Creates Problem Details carrying a correlation ID.
pub fn response(
    code: &'static str,
    title: &'static str,
    status: u16,
    correlation: &str,
) -> Result<Response> {
    let body = Problem {
        type_uri: format!("{TYPE_BASE}{code}"),
        title,
        status,
        error_code: code,
        correlation_id: correlation,
    };
    let headers = Headers::new();
    headers.set("content-type", "application/problem+json")?;
    headers.set("cache-control", "no-store")?;
    headers.set("x-moesegfault-correlation-id", correlation)?;
    Ok(Response::from_json(&body)?
        .with_status(status)
        .with_headers(headers))
}
