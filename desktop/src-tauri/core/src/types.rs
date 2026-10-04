//! Validated domain newtypes.
//!
//! Every value entering the kernel is parsed once here, so the rest of the
//! crate never re-checks an ID shape or a number range. Local `Rev`, remote
//! `RemoteRev` and the local change `Cursor` are three unrelated sequences
//! (20 §15.3); separate types make mixing them a compile error.
//!
//! Numeric bounds follow `@shared/backend-types`: every integer the TS side
//! reads must be a non-negative safe integer, otherwise JSON round-trips lose
//! precision.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize, Serializer};

use crate::error::Error;

/// Largest integer a JS `number` represents exactly (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

const ID_LEN: usize = 26;

/// `^[0-9a-hjkmnp-tv-z]{26}$`, the shape produced by worker `lib/id.ts`
/// (`isValidId`, lines 45–48). Byte checks are enough: every allowed
/// character is ASCII, so any multi-byte input fails the alphabet test.
fn is_id_shape(value: &str) -> bool {
    value.len() == ID_LEN
        && value.bytes().all(|byte| {
            matches!(byte, b'0'..=b'9' | b'a'..=b'h' | b'j' | b'k' | b'm' | b'n' | b'p'..=b't' | b'v'..=b'z')
        })
}

macro_rules! id_type {
    ($(#[$meta:meta])* $name:ident, $field:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Deserialize)]
        #[serde(try_from = "String")]
        pub struct $name(String);

        impl $name {
            /// Validates an owned string, keeping its allocation.
            ///
            /// # Errors
            ///
            /// `Error::InvalidInput` unless `value` is a 26-character Crockford base32 ID.
            pub fn new(value: String) -> Result<Self, Error> {
                if is_id_shape(&value) {
                    Ok(Self(value))
                } else {
                    Err(Error::invalid($field, "must be a 26-character id"))
                }
            }

            /// Borrowed view for SQL binding and comparisons.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }

            /// Releases the inner string without copying.
            #[must_use]
            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl FromStr for $name {
            type Err = Error;

            fn from_str(value: &str) -> Result<Self, Error> {
                if is_id_shape(value) {
                    Ok(Self(value.to_owned()))
                } else {
                    Err(Error::invalid($field, "must be a 26-character id"))
                }
            }
        }

        impl TryFrom<String> for $name {
            type Error = Error;

            fn try_from(value: String) -> Result<Self, Error> {
                Self::new(value)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.0)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

id_type!(
    /// ID of a note row.
    NoteId,
    "noteId"
);
id_type!(
    /// ID of a folder row.
    FolderId,
    "folderId"
);
id_type!(
    /// ID of a tag row.
    TagId,
    "tagId"
);
id_type!(
    /// ID of an attachment row; also its file name under `files\`.
    AttachmentId,
    "attachmentId"
);
id_type!(
    /// ID of a note version snapshot.
    VersionId,
    "versionId"
);

macro_rules! int_type {
    ($(#[$meta:meta])* $name:ident, $field:literal, $min:literal, $reason:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "i64", into = "i64")]
        pub struct $name(i64);

        impl $name {
            /// Validates the range.
            ///
            /// # Errors
            ///
            #[doc = concat!("`Error::InvalidInput` unless `", stringify!($min), " <= value <= MAX_SAFE_INTEGER`.")]
            pub fn new(value: i64) -> Result<Self, Error> {
                if ($min..=MAX_SAFE_INTEGER).contains(&value) {
                    Ok(Self(value))
                } else {
                    Err(Error::invalid($field, $reason))
                }
            }

            /// Raw value for SQL binding and arithmetic.
            #[must_use]
            pub const fn get(self) -> i64 {
                self.0
            }
        }

        impl TryFrom<i64> for $name {
            type Error = Error;

            fn try_from(value: i64) -> Result<Self, Error> {
                Self::new(value)
            }
        }

        impl From<$name> for i64 {
            fn from(value: $name) -> Self {
                value.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0)
            }
        }
    };
}

int_type!(
    /// Local note revision (`notes.rev`), starting at 1. Never compared with
    /// [`RemoteRev`].
    Rev,
    "rev",
    1,
    "must be a positive integer"
);
int_type!(
    /// Revision a remote Web instance reported for an entity. Its own domain:
    /// never written to or compared with the local [`Rev`].
    RemoteRev,
    "remoteRev",
    0,
    "must be a non-negative integer"
);
int_type!(
    /// Local change-feed position (`changes.seq`); the `cursor` of a local
    /// `SyncResponse`. Never a note revision.
    Cursor,
    "cursor",
    0,
    "must be a non-negative integer"
);
int_type!(
    /// Unix timestamp in milliseconds.
    Millis,
    "timestamp",
    0,
    "must be a non-negative millisecond timestamp"
);

impl Rev {
    /// Revision of a freshly created note.
    pub const FIRST: Self = Self(1);
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "a failed unwrap is a failed test"
)]
mod tests {
    use super::*;
    use crate::error::{AppError, ErrorCode, ErrorDetails};

    const VALID_ID: &str = "01hzx3k8m9n0p1q2r3s4t5v6w7";

    fn bad_field(error: Error) -> &'static str {
        let error = AppError::from(error);
        assert_eq!(error.code(), ErrorCode::BadRequest);
        match error.details() {
            Some(ErrorDetails::Field { field }) => field,
            other => panic!("expected a field detail, got {other:?}"),
        }
    }

    #[test]
    fn id_accepts_the_worker_alphabet() {
        let id: NoteId = VALID_ID.parse().unwrap();
        assert_eq!(id.as_str(), VALID_ID);
        assert!(FolderId::new("0123456789abcdefghjkmnpqrs".to_owned()).is_ok());
        assert!(TagId::new("tvwxyz0123456789abcdefghjk".to_owned()).is_ok());
    }

    #[test]
    fn id_rejects_wrong_length_case_and_excluded_letters() {
        let cases = [
            &VALID_ID[..25],
            "01hzx3k8m9n0p1q2r3s4t5v6w78",
            "01HZX3K8M9N0P1Q2R3S4T5V6W7",
            "01hzx3k8m9n0p1q2r3s4t5v6wi",
            "01hzx3k8m9n0p1q2r3s4t5v6wl",
            "01hzx3k8m9n0p1q2r3s4t5v6wo",
            "01hzx3k8m9n0p1q2r3s4t5v6wu",
            "",
            // 26 bytes, but the last character is two bytes wide.
            "01hzx3k8m9n0p1q2r3s4t5v6é",
            "../../../../windows/system",
        ];
        for case in cases {
            assert_eq!(
                bad_field(case.parse::<NoteId>().unwrap_err()),
                "noteId",
                "{case:?}"
            );
        }
        assert_eq!(
            bad_field(VersionId::new(String::new()).unwrap_err()),
            "versionId"
        );
        assert_eq!(
            bad_field("x".parse::<AttachmentId>().unwrap_err()),
            "attachmentId"
        );
    }

    #[test]
    fn rev_starts_at_one_and_stays_safe_for_js() {
        assert_eq!(Rev::new(1).unwrap(), Rev::FIRST);
        assert_eq!(Rev::new(MAX_SAFE_INTEGER).unwrap().get(), MAX_SAFE_INTEGER);
        for value in [0, -1, i64::MIN, MAX_SAFE_INTEGER + 1, i64::MAX] {
            assert_eq!(bad_field(Rev::new(value).unwrap_err()), "rev", "{value}");
        }
    }

    #[test]
    fn remote_rev_and_cursor_are_separate_domains_with_their_own_ranges() {
        assert_eq!(RemoteRev::new(0).unwrap().get(), 0);
        assert_eq!(Cursor::new(0).unwrap().get(), 0);
        assert_eq!(bad_field(RemoteRev::new(-1).unwrap_err()), "remoteRev");
        assert_eq!(bad_field(Cursor::new(-1).unwrap_err()), "cursor");
        assert_eq!(
            bad_field(Cursor::new(MAX_SAFE_INTEGER + 1).unwrap_err()),
            "cursor"
        );
    }

    #[test]
    fn millis_is_a_non_negative_safe_integer() {
        assert_eq!(Millis::new(0).unwrap().get(), 0);
        assert!(Millis::new(MAX_SAFE_INTEGER).is_ok());
        for value in [-1, MAX_SAFE_INTEGER + 1] {
            assert_eq!(
                bad_field(Millis::new(value).unwrap_err()),
                "timestamp",
                "{value}"
            );
        }
    }

    #[test]
    fn serde_uses_plain_json_values_and_validates_on_parse() {
        let id: NoteId = VALID_ID.parse().unwrap();
        assert_eq!(
            serde_json::to_value(&id).unwrap(),
            serde_json::json!(VALID_ID)
        );
        assert_eq!(
            serde_json::to_value(Rev::new(7).unwrap()).unwrap(),
            serde_json::json!(7)
        );

        assert!(serde_json::from_value::<NoteId>(serde_json::json!("NOT-AN-ID")).is_err());
        assert!(serde_json::from_value::<Rev>(serde_json::json!(0)).is_err());
        assert!(serde_json::from_value::<Millis>(serde_json::json!(-5)).is_err());
        assert_eq!(
            serde_json::from_value::<Rev>(serde_json::json!(3))
                .unwrap()
                .get(),
            3
        );
    }
}
