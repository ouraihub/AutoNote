use super::*;
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
