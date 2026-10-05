//! Markdown analysis functions shared with the TypeScript implementation.
//!
//! These functions intentionally operate on UTF-8 Rust strings while matching
//! the TypeScript contract's UTF-16 limits and Unicode scalar semantics.

use std::cmp::Ordering;
use std::collections::HashSet;

/// Adds spaces around CJK characters and full-width punctuation.
#[must_use]
pub fn segment_cjk(text: &str) -> String {
    let mut marked = String::with_capacity(text.len() + text.len() / 4);
    for ch in text.chars() {
        if is_cjk_segment_char(ch) {
            marked.push(' ');
            marked.push(ch);
            marked.push(' ');
        } else {
            marked.push(ch);
        }
    }
    let mut output = String::with_capacity(marked.len());
    let mut in_space = false;
    for ch in marked.chars() {
        if ch.is_whitespace() {
            if !in_space {
                output.push(' ');
            }
            in_space = true;
        } else {
            output.push(ch);
            in_space = false;
        }
    }
    output
}

fn is_cjk_segment_char(ch: char) -> bool {
    matches!(ch as u32,
        0x2e80..=0x9fff | 0xf900..=0xfaff | 0xff01..=0xffe0
    )
}

/// Truncates by UTF-16 code units without returning a broken UTF-8 string.
#[must_use]
pub fn truncate_utf16(value: &str, max_units: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (index, ch) in value.char_indices() {
        let next = units + usize::from(ch as u32 > 0xffff) + 1;
        if next > max_units {
            break;
        }
        units = next;
        end = index + ch.len_utf8();
    }
    value[..end].to_string()
}

/// Converts Markdown into the plain text used for excerpts and word counts.
#[must_use]
pub fn to_plain_text(markdown: &str) -> String {
    let body = strip_front_matter(markdown);
    let mut text = strip_code_regions(body);
    replace_line_prefixes(&mut text);
    text = replace_markdown_inline(&text);
    collapse_spaces(&text)
}

/// Derives the excerpt with the shared default UTF-16 limit.
#[must_use]
pub fn derive_excerpt(content: &str, max_units: usize) -> String {
    let plain = to_plain_text(content);
    let title = derive_title(content);
    let mut text = plain;
    if !title.is_empty() && text.starts_with(&title) {
        text = text[title.len()..].to_string();
    }
    text = text.trim().replace('\n', " ");
    if utf16_len(&text) <= max_units {
        return text;
    }
    let truncated = truncate_utf16(&text, max_units);
    let without_partial_word = truncated
        .trim_end()
        .rsplit_once(char::is_whitespace)
        .map_or(truncated.as_str(), |(prefix, _)| prefix)
        .trim_end();
    format!("{without_partial_word}…")
}

fn derive_title(content: &str) -> String {
    let body = strip_front_matter(content);
    for line in strip_code_regions(body).lines() {
        let trimmed = line.trim_start();
        let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
        if (1..=6).contains(&hashes) && trimmed.as_bytes().get(hashes) == Some(&b' ') {
            let title =
                replace_markdown_inline(trimmed[hashes + 1..].trim().trim_end_matches('#').trim());
            if !title.is_empty() {
                return truncate_utf16(&title, 200);
            }
        }
    }
    String::new()
}

/// Counts CJK scalar characters and Latin/number words, with UTF-16-independent
/// Rust scalar count for the source character count (matching TS `[...md]`).
#[must_use]
pub fn count_text(markdown: &str) -> (usize, usize) {
    let plain = to_plain_text(markdown);
    let cjk = plain.chars().filter(|ch| is_cjk_word_char(*ch)).count();
    let latin = count_latin_words(&plain);
    (cjk + latin, markdown.chars().count())
}

fn is_cjk_word_char(ch: char) -> bool {
    matches!(ch as u32, 0x2e80..=0x9fff | 0xf900..=0xfaff)
}

fn count_latin_words(text: &str) -> usize {
    let mut count = 0;
    let mut in_word = false;
    for ch in text.chars() {
        let is_word = ch.is_ascii_alphanumeric() || matches!(ch, '_' | '\'' | '’' | '-');
        if is_word && !in_word {
            count += 1;
        }
        in_word = is_word;
    }
    count
}

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

/// A single wiki link occurrence, with its normalized lookup key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiLink {
    pub target: String,
    pub alias: Option<String>,
    pub key: String,
}

/// Extracts unique wiki links outside code and front matter.
#[must_use]
pub fn extract_wiki_links(content: &str) -> Vec<WikiLink> {
    let body = strip_code_regions(strip_front_matter(content));
    let chars: Vec<char> = body.chars().collect();
    let mut links = Vec::new();
    let mut seen = HashSet::new();
    let mut index = 0;
    while index + 1 < chars.len() {
        if chars[index] != '[' || chars[index + 1] != '[' {
            index += 1;
            continue;
        }
        let Some(end) = chars[index + 2..]
            .windows(2)
            .position(|pair| pair == [']', ']'])
        else {
            break;
        };
        let end = index + 2 + end;
        let inside: String = chars[index + 2..end].iter().collect();
        let mut parts = inside.splitn(2, '|');
        let target = parts.next().unwrap_or_default().trim().to_string();
        let alias = parts
            .next()
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_string);
        let note_target = wiki_note_target(&target);
        let key = normalize_link_key(&note_target);
        if !note_target.is_empty() && seen.insert(key.clone()) {
            links.push(WikiLink { target, alias, key });
            if links.len() >= 200 {
                break;
            }
        }
        index = end + 2;
    }
    links
}

/// Normalizes a title for link lookup.
#[must_use]
pub fn normalize_link_key(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Computes the lower-case SHA-256 digest of UTF-8 bytes without depending on
/// a runtime or allocator-heavy hashing wrapper.
#[must_use]
pub fn sha256_hex(value: &str) -> String {
    let digest = sha256(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Byte positions of attachment IDs in live Markdown URL destinations.
/// Ordinary text, inline/fenced code and comments are not attachment references.
#[must_use]
pub fn attachment_references(content: &str) -> Vec<std::ops::Range<usize>> {
    let body = strip_front_matter(content);
    let base = content.len() - body.len();
    let mut visible = body.as_bytes().to_vec();
    let mut fences: Vec<(char, usize, bool)> = Vec::new();
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        let trimmed = bare.trim_start_matches([' ', '\t']);
        let marker = (bare.len() - trimmed.len() <= 3)
            .then(|| fence_marker(bare))
            .flatten();
        let mut hide = fences.last().is_some_and(|f| !f.2);
        if let Some((ch, length)) = marker {
            let tail = &trimmed[length..];
            if fences
                .last()
                .is_some_and(|f| f.0 == ch && length >= f.1 && tail.trim().is_empty())
            {
                fences.pop();
            } else if !hide {
                let language = tail.split_whitespace().next().unwrap_or("");
                fences.push((
                    ch,
                    length,
                    matches!(language, "md-example" | "markdown-example"),
                ));
            }
            hide = true;
        }
        if hide {
            visible[offset..offset + line.len()].fill(b' ');
        }
        offset += line.len();
    }
    // Mask in bytes, not chars: ranges must still point into the original UTF-8 source.
    let mut i = 0;
    while i < visible.len() {
        let (opening, closing) = if visible[i..].starts_with(b"<!--") {
            (4, b"-->".as_slice())
        } else if visible[i..].starts_with(b"%%") {
            (2, b"%%".as_slice())
        } else if visible[i] == b'`' {
            let count = visible[i..].iter().take_while(|&&b| b == b'`').count();
            let end = visible[i + count..]
                .windows(count)
                .position(|w| w.iter().all(|&b| b == b'`'));
            if let Some(end) = end {
                let end = i + count + end + count;
                visible[i..end].fill(b' ');
                i = end;
                continue;
            }
            i += count;
            continue;
        } else {
            i += 1;
            continue;
        };
        let end = visible[i + opening..]
            .windows(closing.len())
            .position(|w| w == closing)
            .map_or(visible.len(), |end| i + opening + end + closing.len());
        visible[i..end].fill(b' ');
        i = end;
    }
    let mut result = Vec::new();
    for start in 0..visible.len().saturating_sub(36) {
        if !visible[start..].starts_with(b"/api/files/") {
            continue;
        }
        let end = start + 37;
        if end > visible.len() {
            continue;
        }
        let Some(id) = body.get(start + 11..end) else {
            continue;
        };
        if !crate::id::is_valid_id(id) {
            continue;
        }
        if visible
            .get(end)
            .is_some_and(|b| !b.is_ascii_whitespace() && !b">)]\"'?#".contains(b))
        {
            continue;
        }
        let prefix = &visible[..start];
        let previous = prefix.iter().rposition(|b| !b.is_ascii_whitespace());
        let destination = previous.is_some_and(|p| {
            (prefix[p] == b'(' && p > 0 && prefix[p - 1] == b']')
                || (prefix[p] == b'<' && p > 0 && prefix[p - 1] == b'(')
        });
        let line_start = prefix
            .iter()
            .rposition(|&b| b == b'\n')
            .map_or(0, |p| p + 1);
        let line_prefix = String::from_utf8_lossy(&prefix[line_start..]);
        let definition = line_prefix.trim_start().starts_with('[')
            && line_prefix
                .trim_end_matches([' ', '\t', '<'])
                .ends_with("]:");
        let attribute = previous.is_some_and(|p| {
            let before = String::from_utf8_lossy(&prefix[line_start..p + 1]);
            (before.ends_with("src=\"")
                || before.ends_with("src='")
                || before.ends_with("href=\"")
                || before.ends_with("href='"))
                && before.contains('<')
                && !before.contains('>')
        });
        if destination || definition || attribute {
            result.push(base + start + 11..base + end);
        }
    }
    result
}

fn wiki_note_target(target: &str) -> String {
    if target.starts_with('#') || target.starts_with('^') {
        return String::new();
    }
    target
        .split_once('#')
        .map_or(target, |(note, _)| note)
        .trim()
        .to_string()
}

fn strip_front_matter(text: &str) -> &str {
    let source = text.strip_prefix('\u{feff}').unwrap_or(text);
    if !source.starts_with("---") {
        return source;
    }
    let mut lines = source.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return source;
    };
    if first.trim_end_matches(['\r', '\n']).trim() != "---" {
        return source;
    }
    let mut offset = first.len();
    for line in lines {
        let bare = line.trim_end_matches(['\r', '\n']).trim();
        offset += line.len();
        if bare == "---" || bare == "..." {
            return &source[offset..];
        }
    }
    source
}

fn strip_front_matter_with_tags<'a>(text: &'a str, values: &mut Vec<String>) -> &'a str {
    let source = text.strip_prefix('\u{feff}').unwrap_or(text);
    if !source.starts_with("---") {
        return source;
    }
    let mut lines = source.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return source;
    };
    if first.trim_end_matches(['\r', '\n']).trim() != "---" {
        return source;
    }
    let mut offset = first.len();
    for line in lines {
        let bare = line.trim_end_matches(['\r', '\n']).trim();
        if let Some(value) = bare
            .strip_prefix("tags:")
            .or_else(|| bare.strip_prefix("tag:"))
        {
            for tag in value
                .trim()
                .trim_matches(['[', ']'])
                .split([',', ' ', '\t'])
            {
                let tag = tag.trim().trim_start_matches('#');
                if !tag.is_empty() {
                    values.push(tag.to_string());
                }
            }
        }
        offset += line.len();
        if bare == "---" || bare == "..." {
            return &source[offset..];
        }
    }
    source
}

fn strip_code_regions(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut fence: Option<(char, usize)> = None;
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        let marker = fence_marker(bare);
        if let Some((ch, length)) = fence {
            if marker.is_some_and(|(next, size)| next == ch && size >= length) {
                fence = None;
            }
            output.push_str(
                &line
                    .chars()
                    .map(|ch| if ch == '\n' || ch == '\r' { ch } else { ' ' })
                    .collect::<String>(),
            );
        } else if let Some(next) = marker {
            fence = Some(next);
            output.push_str(
                &line
                    .chars()
                    .map(|ch| if ch == '\n' || ch == '\r' { ch } else { ' ' })
                    .collect::<String>(),
            );
        } else {
            output.push_str(&strip_inline_code(line));
        }
    }
    output
}

fn fence_marker(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start_matches([' ', '\t']);
    let mut chars = trimmed.chars();
    let ch = chars.next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let count = trimmed.chars().take_while(|item| *item == ch).count();
    (count >= 3).then_some((ch, count))
}

fn strip_html_comments(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        output.push_str(&rest[..start]);
        let Some(end) = rest[start + 4..].find("-->") else {
            break;
        };
        let end = start + 4 + end + 3;
        output.extend(
            rest[start..end]
                .chars()
                .map(|ch| if ch == '\n' || ch == '\r' { ch } else { ' ' }),
        );
        rest = &rest[end..];
    }
    output.push_str(rest);
    output
}

fn strip_inline_code(line: &str) -> String {
    let mut result = String::new();
    let mut in_code = false;
    for ch in line.chars() {
        if ch == '`' {
            in_code = !in_code;
            result.push(' ');
        } else if in_code {
            result.push(' ');
        } else {
            result.push(ch);
        }
    }
    result
}

fn replace_line_prefixes(text: &mut String) {
    let mut output = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let mut value = line.to_string();
        let trimmed = value.trim_start_matches([' ', '\t']);
        if trimmed.starts_with('#') {
            value = trimmed.trim_start_matches('#').trim_start().to_string();
        } else if let Some(rest) = trimmed.strip_prefix('>') {
            value = rest.trim_start().to_string();
        } else if trimmed.len() >= 2
            && (trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ "))
        {
            value = trimmed[2..].to_string();
        }
        output.push_str(&value);
    }
    *text = output;
}

fn replace_markdown_inline(text: &str) -> String {
    let mut output = text.replace("$$", "").replace('$', "");
    output = replace_bracket_content(&output, "![", true);
    output = replace_bracket_content(&output, "[", false);
    output = output
        .replace("**", "")
        .replace("__", "")
        .replace(['~', '='], "");
    output
}

fn replace_bracket_content(text: &str, prefix: &str, image: bool) -> String {
    let mut output = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(prefix) {
        output.push_str(&rest[..start]);
        let Some(close) = rest[start + prefix.len()..].find(']') else {
            output.push_str(&rest[start..]);
            break;
        };
        let close = start + prefix.len() + close;
        let after = &rest[close + 1..];
        if after.starts_with('(') {
            let Some(end) = after.find(')') else {
                output.push_str(&rest[start..]);
                break;
            };
            output.push_str(&rest[start + prefix.len()..close]);
            rest = &after[end + 1..];
        } else if !image {
            output.push_str(&rest[start..close + 1]);
            rest = after;
        } else {
            output.push_str(&rest[start..]);
            break;
        }
    }
    if !rest.is_empty() {
        output.push_str(rest);
    }
    output
}

fn collapse_spaces(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    for line in text.lines() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(
            line.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .as_str(),
        );
    }
    output.trim().to_string()
}

fn utf16_len(value: &str) -> usize {
    value
        .chars()
        .map(|ch| usize::from(ch as u32 > 0xffff) + 1)
        .sum()
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

fn sha256(input: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut data = input.to_vec();
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    for chunk in data.chunks_exact(64) {
        let mut w = [0_u32; 64];
        for (i, bytes) in chunk.chunks_exact(4).take(16).enumerate() {
            w[i] = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    let mut output = [0_u8; 32];
    for (index, value) in h.into_iter().enumerate() {
        output[index * 4..index * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
    output
}

#[cfg(test)]
#[allow(
    clippy::expect_used,
    reason = "fixture assertions use explicit parse failures"
)]
mod tests {
    use super::{
        count_text, derive_excerpt, extract_tags, extract_wiki_links, normalize_link_key,
        segment_cjk, sha256_hex,
    };
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../../fixtures/markdown-pure.json"))
            .expect("markdown fixture is valid JSON")
    }

    #[test]
    fn markdown_functions_match_ts_fixture() {
        let binding = fixture();
        let cases = binding["markdown"]
            .as_array()
            .expect("markdown cases array");

        let segmented = &cases[0];
        let input = segmented["input"].as_str().expect("segment input");
        assert_eq!(
            segment_cjk(input),
            segmented["segmentCjk"].as_str().expect("segment result")
        );
        assert_eq!(
            sha256_hex(input),
            segmented["sha256"].as_str().expect("sha256 result")
        );

        let text = &cases[1];
        let input = text["input"].as_str().expect("text input");
        assert_eq!(
            derive_excerpt(input, 220),
            text["excerpt"].as_str().expect("excerpt")
        );
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
        assert_eq!(
            actual[0].target,
            expected["target"].as_str().expect("target")
        );
        assert_eq!(
            actual[0].alias,
            expected["alias"].as_str().map(str::to_string)
        );
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
}
