//! Endpoint address normalization (doc 23 §5).

/// API root for `base_url`: trailing `/` removed, `/v1` appended unless the
/// path already ends with it.
#[must_use]
pub fn api_base(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/v1") {
        base.to_owned()
    } else {
        format!("{base}/v1")
    }
}

/// Model list URL probed for `base_url`.
#[must_use]
pub fn probe_url(base_url: &str) -> String {
    format!("{}/models", api_base(base_url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base() {
        for (input, expected) in [
            ("https://api.example.com", "https://api.example.com/v1"),
            ("https://api.example.com/", "https://api.example.com/v1"),
            ("https://api.example.com/v1", "https://api.example.com/v1"),
            ("https://api.example.com/v1//", "https://api.example.com/v1"),
            (
                "https://relay.example.com/openai",
                "https://relay.example.com/openai/v1",
            ),
            (
                " https://api.example.com/v1/ ",
                "https://api.example.com/v1",
            ),
        ] {
            assert_eq!(api_base(input), expected, "{input}");
        }
        assert_eq!(
            probe_url("https://api.example.com/"),
            "https://api.example.com/v1/models"
        );
    }
}
