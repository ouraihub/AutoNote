use super::*;
use std::cmp::Ordering;
use std::collections::HashSet;
/// Extracts front-matter and body tags, de-duplicated and numerically sorted.
#[must_use]
pub fn extract_tags(content: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut keys = HashSet::new();
    let body = strip_front_matter_with_tags(content, &mut values);
    let safe = strip_html_comments(&strip_code_regions(body));
    let chars: Vec<char> = safe.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '#' || (index > 0 && !is_tag_prefix(chars[index - 1])) {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut end = start;
        while end < chars.len() && is_tag_char(chars[end]) {
            end += 1;
        }
        let name: String = chars[start..end].iter().collect();
        let normalized = name.to_lowercase();
        if !name.is_empty()
            && name.chars().all(|ch| !ch.is_ascii_digit())
            && keys.insert(normalized)
        {
            values.push(name);
        }
        index = end.max(index + 1);
    }
    values.truncate(64);
    sort_tag_names(&mut values);
    values
}

/// Sorts tags using a deterministic approximation of `Intl.Collator` numeric
/// and base sensitivity, exposed for database row ordering.
pub fn sort_tag_names(tags: &mut [String]) {
    tags.sort_by(|left, right| compare_tag_names(left, right));
}

pub(crate) fn compare_tag_names(left: &str, right: &str) -> Ordering {
    let left_lower = left.to_lowercase();
    let right_lower = right.to_lowercase();
    compare_numeric_chunks(&left_lower, &right_lower).then_with(|| left.cmp(right))
}

fn compare_numeric_chunks(left: &str, right: &str) -> Ordering {
    let mut li = left.chars().peekable();
    let mut ri = right.chars().peekable();
    loop {
        match (li.peek(), ri.peek()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(l), Some(r)) if l.is_ascii_digit() && r.is_ascii_digit() => {
                let mut ln = String::new();
                let mut rn = String::new();
                while li.peek().is_some_and(char::is_ascii_digit) {
                    ln.push(li.next().unwrap_or('0'));
                }
                while ri.peek().is_some_and(char::is_ascii_digit) {
                    rn.push(ri.next().unwrap_or('0'));
                }
                let ltrim = ln.trim_start_matches('0');
                let rtrim = rn.trim_start_matches('0');
                match ltrim.len().cmp(&rtrim.len()).then_with(|| ltrim.cmp(rtrim)) {
                    Ordering::Equal => {}
                    other => return other,
                }
            }
            (Some(_), Some(_)) => {
                let l = li.next().unwrap_or('\0');
                let r = ri.next().unwrap_or('\0');
                match l.cmp(&r) {
                    Ordering::Equal => {}
                    other => return other,
                }
            }
        }
    }
}
fn is_tag_prefix(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '(' | '（' | '[' | '【' | '>' | '「' | '『' | '，' | ',' | '、' | ';' | '；'
        )
}
fn is_tag_char(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '_' | '-' | '/' | '·')
}
