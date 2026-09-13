//! 强类型标识符。/ Strongly typed identifiers.

use core::{fmt, marker::PhantomData, str::FromStr};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use uuid::{Timestamp, Uuid};

/// 无业务语义的 UUID 标识符。/ UUID identifier without business semantics.
///
/// 标记类型阻止把会话 ID 误传为主体 ID。序列化格式固定为带连字符的小写 UUID。
/// The marker type prevents passing a session ID where a principal ID is expected.
#[derive(PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Id<K> {
    value: Uuid,
    marker: PhantomData<fn() -> K>,
}

impl<K> Copy for Id<K> {}

impl<K> Clone for Id<K> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<K> Id<K> {
    /// 从已验证 UUID 构造。/ Constructs from an already validated UUID.
    #[must_use]
    pub const fn from_uuid(value: Uuid) -> Self {
        Self {
            value,
            marker: PhantomData,
        }
    }

    /// 返回底层 UUID。/ Returns the underlying UUID.
    #[must_use]
    pub const fn as_uuid(self) -> Uuid {
        self.value
    }
}

impl<K> Id<K> {
    /// 创建 UUIDv4 标识符。/ Creates a UUIDv4 identifier.
    #[must_use]
    pub fn new_v4() -> Self {
        Self::from_uuid(Uuid::new_v4())
    }

    /// 用调用方提供的 Unix 毫秒创建可排序 UUIDv7。
    /// Creates a sortable UUIDv7 from caller-supplied Unix milliseconds.
    #[must_use]
    pub fn new_v7(unix_millis: u64) -> Self {
        let seconds = unix_millis / 1_000;
        let nanos = ((unix_millis % 1_000) * 1_000_000) as u32;
        Self::from_uuid(Uuid::new_v7(Timestamp::from_unix(
            uuid::NoContext,
            seconds,
            nanos,
        )))
    }
}

impl<K> fmt::Display for Id<K> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.value.fmt(f)
    }
}

impl<K> fmt::Debug for Id<K> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Id").field(&self.value).finish()
    }
}

impl<K> FromStr for Id<K> {
    type Err = uuid::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value).map(Self::from_uuid)
    }
}

impl<K> Serialize for Id<K> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.value.hyphenated().to_string())
    }
}

impl<'de, K> Deserialize<'de> for Id<K> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = <&str>::deserialize(deserializer)?;
        value.parse().map_err(de::Error::custom)
    }
}

macro_rules! id_kind {
    ($marker:ident, $alias:ident) => {
        #[doc = concat!("", stringify!($alias), " 的类型标记。/ Type marker for `", stringify!($alias), "`.")]
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub enum $marker {}
        #[doc = concat!("强类型 ", stringify!($alias), "。/ Strongly typed `", stringify!($alias), "`.")]
        pub type $alias = Id<$marker>;
    };
}

id_kind!(Principal, PrincipalId);
id_kind!(Identifier, IdentifierId);
id_kind!(Authenticator, AuthenticatorId);
id_kind!(Binding, BindingId);
id_kind!(Session, SessionId);
id_kind!(TransactionIdKind, TransactionId);
id_kind!(TokenFamily, TokenFamilyId);
id_kind!(AuditEvent, AuditEventId);
id_kind!(OutboxEvent, OutboxEventId);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_without_losing_type() {
        let id = PrincipalId::new_v4();
        let json = serde_json::to_string(&id).expect("serialize");
        let parsed: PrincipalId = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(id, parsed);
    }

    #[test]
    fn v7_embeds_requested_timestamp() {
        let id = AuthenticatorId::new_v7(1_700_000_000_123);
        assert_eq!(id.as_uuid().get_version_num(), 7);
        assert_eq!(
            id.as_uuid().get_timestamp().unwrap().to_unix().0,
            1_700_000_000
        );
    }
}
