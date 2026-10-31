#[allow(
    clippy::expect_used,
    reason = "fixture assertions use explicit parse failures"
)]
use serde_json::Value;

use super::{
    count_text, derive_excerpt, extract_tags, extract_wiki_links, normalize_link_key,
    segment_cjk, sha256_hex,
};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/markdown-pure.json"))
        .expect("markdown fixture is valid JSON")
}

#[test]
fn markdown_functions_match_ts_fixture() {
    let binding = fixture();
    let cases = binding["markdown"].as_array().expect("markdown cases array");

    let segmented = &cases[0];
    let input = segmented["input"].as_str().expect("segment input");
    assert_eq!(segment_cjk(input), segmented["segmentCjk"].as_str().expect("segment result"));
    assert_eq!(sha256_hex(input), segmented["sha256"].as_str().expect("sha256 result"));

    let text = &cases[1];
    let input = text["input"].as_str().expect("text input");
    assert_eq!(derive_excerpt(input, 220), text["excerpt"].as_str().expect("excerpt"));
    let (words, chars) = count_text(input);
    assert_eq!(words, text["words"].as_u64().expect("word count") as usize);
    assert_eq!(chars, text["chars"].as_u64().expect("char count") as usize);

    let tags = &cases[2];
    let input = tags["input"].as_str().expect("tag input");
    let expected_tags: Vec<String> = tags["tags"]
        .as_array()
        .expect("tag result array")
        .iter()
        .map(|value| value.as_str().expect("tag string").to_string())
        .collect();
    assert_eq!(extract_tags(input), expected_tags);

    let links = &cases[3];
    let input = links["input"].as_str().expect("wiki input");
    let expected = &links["wikiLinks"][0];
    let actual = extract_wiki_links(input);
    assert_eq!(actual.len(), 1);
    assert_eq!(actual[0].target, expected["target"].as_str().expect("target"));
    assert_eq!(actual[0].alias, expected["alias"].as_str().map(str::to_string));
    assert_eq!(actual[0].key, expected["key"].as_str().expect("key"));

    let key = &cases[4];
    assert_eq!(
        normalize_link_key(key["input"].as_str().expect("key input")),
        key["linkKey"].as_str().expect("link key")
    );
}

#[test]
fn unicode_truncation_never_splits_non_bmp() {
    assert_eq!(super::truncate_utf16("a😀b", 2), "a");
    assert_eq!(super::truncate_utf16("a😀b", 3), "a😀");
    assert_eq!(super::truncate_utf16("é", 1), "e");
}

#[test]
fn dangerous_regions_are_not_analyzed() {
    let input = "<!-- #comment -->\n~~~\n#fenced [[link]]\n~~~\n#real [[target]]";
    assert_eq!(extract_tags(input), vec!["real"]);
    let links = extract_wiki_links(input);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].key, "target");
}
