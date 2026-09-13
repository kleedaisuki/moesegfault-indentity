//! Cloudflare 无关的身份领域模型。/ Cloudflare-independent identity domain model.
//!
//! 本 crate 只表达稳定类型、不变量和纯函数；存储与网络属于适配器。
//! This crate owns stable types, invariants, and pure functions only; storage and
//! transport belong to adapters.

#![forbid(unsafe_code)]

mod ids;
mod model;
mod policy;
mod secret;

pub use ids::*;
pub use model::*;
pub use policy::*;
pub use secret::*;
