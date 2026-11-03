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

pub(crate) fn is_cjk_segment_char(ch: char) -> bool {
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
pub(crate) fn wiki_note_target(target: &str) -> String {
    if target.starts_with('#') || target.starts_with('^') {
        return String::new();
    }
    target
        .split_once('#')
        .map_or(target, |(note, _)| note)
        .trim()
        .to_string()
}

pub(crate) fn strip_front_matter(text: &str) -> &str {
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

pub(crate) fn strip_front_matter_with_tags<'a>(text: &'a str, values: &mut Vec<String>) -> &'a str {
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

pub(crate) fn strip_code_regions(text: &str) -> String {
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

pub(crate) fn fence_marker(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start_matches([' ', '\t']);
    let mut chars = trimmed.chars();
    let ch = chars.next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let count = trimmed.chars().take_while(|item| *item == ch).count();
    (count >= 3).then_some((ch, count))
}

pub(crate) fn strip_html_comments(text: &str) -> String {
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

pub(crate) fn replace_line_prefixes(text: &mut String) {
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

pub(crate) fn replace_markdown_inline(text: &str) -> String {
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

pub(crate) fn collapse_spaces(text: &str) -> String {
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
