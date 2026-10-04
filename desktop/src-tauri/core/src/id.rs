//! 26-character Crockford-base32 IDs shared with the Worker.

/// The alphabet used by `web/src/worker/lib/id.ts`.
pub const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// Encodes a millisecond timestamp followed by sixteen random bytes.
///
/// The timestamp occupies ten high-to-low base32 characters. Random bytes use
/// only their low five bits, exactly as the Worker implementation does.
#[must_use]
pub fn encode_id(millis: u64, random: &[u8; 16]) -> String {
    let mut output = String::with_capacity(26);
    let mut timestamp = millis;
    let mut timestamp_chars = [b'0'; 10];
    for index in (0..10).rev() {
        timestamp_chars[index] = ALPHABET[(timestamp % 32) as usize];
        timestamp /= 32;
    }
    for byte in timestamp_chars {
        output.push(byte as char);
    }
    for byte in random {
        output.push(ALPHABET[(byte & 31) as usize] as char);
    }
    output
}

/// Returns whether `value` is a lower-case 26-character Worker ID.
#[must_use]
pub fn is_valid_id(value: &str) -> bool {
    value.len() == 26
        && value.bytes().all(|byte| {
            matches!(
                byte,
                b'0'..=b'9'
                    | b'a'..=b'h'
                    | b'j'..=b'k'
                    | b'm'..=b'n'
                    | b'p'..=b't'
                    | b'v'..=b'z'
            )
        })
}

/// Decodes the first ten timestamp characters, returning zero on an invalid
/// character. This intentionally accepts the same partial inputs as TS
/// `idTime` rather than requiring a complete ID.
#[must_use]
pub fn id_time(value: &str) -> u64 {
    let mut timestamp = 0_u64;
    for byte in value.bytes().take(10) {
        let Some(index) = ALPHABET.iter().position(|candidate| *candidate == byte) else {
            return 0;
        };
        timestamp = timestamp.saturating_mul(32).saturating_add(index as u64);
    }
    timestamp
}

#[cfg(test)]
mod tests {
    use super::{encode_id, id_time, is_valid_id};

    #[test]
    fn encodes_fixed_timestamp_and_random_bytes() {
        let random = [0_u8; 16];
        let id = encode_id(1, &random);
        assert_eq!(id, "00000000010000000000000000");
        assert_eq!(id_time(&id), 1);
    }

    #[test]
    fn validates_exact_worker_shape() {
        assert!(is_valid_id("0000000001000000000000000z"));
        assert!(!is_valid_id("0000000001000000000000000O"));
        assert!(!is_valid_id("0000000001"));
        assert!(!is_valid_id(
            "0000000001000000000000000z".to_uppercase().as_str()
        ));
    }
}

#[cfg(test)]
#[allow(
    clippy::expect_used,
    reason = "fixture assertions use explicit parse failures"
)]
mod fixture_tests {
    use super::{encode_id, is_valid_id};
    use serde_json::Value;

    #[test]
    fn id_encoding_matches_ts_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../fixtures/markdown-pure.json"))
                .expect("markdown fixture is valid JSON");
        for case in fixture["id"].as_array().expect("id cases array") {
            let millis = case["millis"].as_u64().expect("millis");
            let random: [u8; 16] = case["random"]
                .as_array()
                .expect("random array")
                .iter()
                .map(|value| value.as_u64().expect("random byte") as u8)
                .collect::<Vec<_>>()
                .try_into()
                .expect("sixteen random bytes");
            let encoded = encode_id(millis, &random);
            assert_eq!(encoded, case["encoded"].as_str().expect("encoded ID"));
            assert!(is_valid_id(&encoded));
        }
    }
}
