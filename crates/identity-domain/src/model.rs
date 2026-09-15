//! 身份实体和状态机。/ Identity entities and state machines.

use serde::{Deserialize, Serialize};

use crate::{AuthenticatorId, BindingId, PrincipalId, SessionId, TransactionId};

/// 主体类型。/ Principal kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalKind {
    /// 人类主体。/ Human principal.
    Human,
    /// 机器工作负载。/ Machine workload.
    Workload,
}

/// 主体生命周期。/ Principal lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalState {
    Active,
    Suspended,
    PendingDeletion,
    Deleted,
}

impl PrincipalState {
    /// 只有 active 可创建普通会话。/ Only active principals may create normal sessions.
    #[must_use]
    pub const fn may_authenticate(self) -> bool {
        matches!(self, Self::Active)
    }

    /// 检查不可逆或受控状态迁移。/ Validates irreversible or controlled transitions.
    pub fn transition(self, next: Self) -> Result<Self, DomainError> {
        use PrincipalState as S;
        let allowed = matches!(
            (self, next),
            (S::Active, S::Suspended)
                | (S::Active, S::PendingDeletion)
                | (S::Suspended, S::Active)
                | (S::Suspended, S::PendingDeletion)
                | (S::PendingDeletion, S::Deleted)
        ) || self == next;
        allowed
            .then_some(next)
            .ok_or(DomainError::InvalidTransition)
    }
}

/// 认证器摘要；公钥材料只在存储适配器中承载。
/// Authenticator summary; the storage adapter carries public-key material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthenticatorSummary {
    pub authenticator_id: AuthenticatorId,
    pub label: String,
    pub transports: Vec<String>,
    pub backup_eligible: bool,
    pub backup_state: bool,
    pub created_at: u64,
    pub last_used_at: Option<u64>,
    pub revoked_at: Option<u64>,
}

/// 身份会话摘要。/ Identity-session summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session_id: SessionId,
    pub authenticator_id: Option<AuthenticatorId>,
    pub authenticated_at: u64,
    pub last_seen_at: u64,
    pub expires_at: u64,
    pub current: bool,
    pub revoked_at: Option<u64>,
}

/// 外部身份绑定摘要。/ External identity-binding summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BindingSummary {
    pub binding_id: BindingId,
    pub issuer: String,
    pub provider: String,
    pub authentication_enabled: bool,
    pub created_at: u64,
}

/// 账户可验证联系渠道。/ Verifiable account contact channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactKind {
    /// 电子邮箱地址。/ Email address.
    Email,
    /// E.164 国际电话号码。/ E.164 international telephone number.
    Mobile,
}

/// 联系渠道的验证生命周期。/ Verification lifecycle for a contact channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationState {
    /// 尚未完成带外验证。/ Out-of-band verification has not completed.
    Unverified,
    /// 联系渠道已经过验证。/ The contact channel has been verified.
    Verified,
}

/// 认证方法；类型显式保留未来 MFA 组合，而不是散落字符串判断。
/// Authentication method; the type reserves future MFA composition instead of
/// scattering string comparisons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticationMethod {
    /// 用户记忆密码。/ User-memorized password.
    Password,
    /// WebAuthn Passkey。/ WebAuthn passkey.
    Passkey,
    /// 外部 OpenID Connect 身份。/ External OpenID Connect identity.
    Federated,
}

/// 多因素认证器类别。/ Multi-factor authenticator category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MfaFactorKind {
    /// 基于时间的一次性密码。/ Time-based one-time password (TOTP).
    Totp,
    /// Passkey 作为第二或更高保证级别因素。/ Passkey used as a higher-assurance factor.
    Passkey,
    /// 单次使用恢复码。/ Single-use recovery code.
    RecoveryCode,
}

/// 浏览器认证事务类型。/ Browser ceremony transaction kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionKind {
    Registration,
    Authentication,
    AddAuthenticator,
    Reauthentication,
    Recovery,
    Binding,
}

/// 一次性事务状态。/ One-shot transaction state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionState {
    Pending,
    Consumed,
    Expired,
    Cancelled,
}

/// 事务元数据，不包含 challenge。/ Transaction metadata, excluding its challenge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transaction {
    pub transaction_id: TransactionId,
    pub kind: TransactionKind,
    pub principal_id: Option<PrincipalId>,
    pub state: TransactionState,
    pub created_at: u64,
    pub expires_at: u64,
}

impl Transaction {
    /// 在给定时刻判断事务能否被原子消费。
    /// Determines whether the transaction may be atomically consumed at `now`.
    pub fn consumption_state(&self, now: u64) -> Result<TransactionState, DomainError> {
        if now >= self.expires_at {
            return Err(DomainError::TransactionExpired);
        }
        if self.state != TransactionState::Pending {
            return Err(DomainError::TransactionConsumed);
        }
        Ok(TransactionState::Consumed)
    }
}

/// 撤销认证器前的领域判定。/ Domain decision before authenticator revocation.
pub fn ensure_may_revoke_authenticator(
    active_authenticator_count: usize,
    recently_authenticated: bool,
) -> Result<(), DomainError> {
    if !recently_authenticated {
        return Err(DomainError::ReauthenticationRequired);
    }
    if active_authenticator_count <= 1 {
        return Err(DomainError::LastAuthenticator);
    }
    Ok(())
}

/// 稳定领域错误。/ Stable domain errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DomainError {
    #[error("invalid state transition")]
    InvalidTransition,
    #[error("transaction has expired")]
    TransactionExpired,
    #[error("transaction has already been consumed")]
    TransactionConsumed,
    #[error("recent passkey authentication is required")]
    ReauthenticationRequired,
    #[error("the last authenticator cannot be revoked")]
    LastAuthenticator,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleted_principal_cannot_be_reactivated() {
        assert_eq!(
            PrincipalState::Deleted.transition(PrincipalState::Active),
            Err(DomainError::InvalidTransition)
        );
    }

    #[test]
    fn pending_transaction_is_one_shot_and_expires_at_boundary() {
        let tx = Transaction {
            transaction_id: TransactionId::new_v4(),
            kind: TransactionKind::Authentication,
            principal_id: None,
            state: TransactionState::Pending,
            created_at: 100,
            expires_at: 400,
        };
        assert_eq!(tx.consumption_state(399), Ok(TransactionState::Consumed));
        assert_eq!(
            tx.consumption_state(400),
            Err(DomainError::TransactionExpired)
        );
    }

    #[test]
    fn cannot_remove_last_or_remove_without_step_up() {
        assert_eq!(
            ensure_may_revoke_authenticator(2, false),
            Err(DomainError::ReauthenticationRequired)
        );
        assert_eq!(
            ensure_may_revoke_authenticator(1, true),
            Err(DomainError::LastAuthenticator)
        );
        assert_eq!(ensure_may_revoke_authenticator(2, true), Ok(()));
    }
}
