use crate::Error;

/// A single scanner keeps code regions byte-for-byte intact, unlike global regex replacement.
pub(in crate::transfer) fn rewrite(
    content: &str,
    resolve: impl FnMut(&str, bool) -> Result<Option<String>, Error>,
) -> Result<String, Error> {
    rewrite_links(content, resolve, true)
}

pub(in crate::transfer) fn rewrite_links(
    content: &str,
    mut resolve: impl FnMut(&str, bool) -> Result<Option<String>, Error>,
    comments: bool,
) -> Result<String, Error> {
    let mut out = String::with_capacity(content.len());
    let mut fenced: Option<(u8, usize)> = None;
    let mut inline = None;
    let mut comment = false;
    for line in content.split_inclusive('\n') {
        if inline.is_none() && !comment && (line.starts_with("    ") || line.starts_with('\t')) {
            out.push_str(line);
            continue;
        }
        let trimmed = line.trim_start();
        let marker = trimmed.as_bytes().first().copied();
        let run = marker.map_or(0, |m| trimmed.bytes().take_while(|b| *b == m).count());
        if inline.is_none() && !comment && matches!(marker, Some(b'`' | b'~')) && run >= 3 {
            if fenced.is_none() {
                fenced = Some((marker.unwrap_or_default(), run));
            } else if fenced.is_some_and(|(m, n)| Some(m) == marker && run >= n) {
                fenced = None;
            }
            out.push_str(line);
            continue;
        }
        if fenced.is_some() {
            out.push_str(line);
            continue;
        }
        let mut index = 0;
        while index < line.len() {
            let tail = &line[index..];
            if comment {
                if let Some(end) = tail.find("%%") {
                    out.push_str(&tail[..end].replace("--", "—"));
                    out.push_str("-->");
                    index += end + 2;
                    comment = false;
                } else {
                    out.push_str(&tail.replace("--", "—"));
                    break;
                }
                continue;
            }
            if let Some(length) = inline {
                let token = "`".repeat(length);
                if let Some(end) = tail.find(&token) {
                    out.push_str(&tail[..end + length]);
                    index += end + length;
                    inline = None;
                } else {
                    out.push_str(tail);
                    break;
                }
                continue;
            }
            if tail.starts_with('\\') {
                let mut chars = tail.chars();
                let _slash = chars.next();
                let length = 1 + chars.next().map_or(0, char::len_utf8);
                out.push_str(&tail[..length]);
                index += length;
                continue;
            }
            if tail.starts_with('`') {
                let n = tail.bytes().take_while(|b| *b == b'`').count();
                let token = "`".repeat(n);
                if let Some(end) = tail[n..].find(&token) {
                    let length = n + end + n;
                    out.push_str(&tail[..length]);
                    index += length;
                    continue;
                }
                out.push_str(&tail[..n]);
                index += n;
                inline = Some(n);
                continue;
            }
            let asset = tail.starts_with("![[");
            let wiki = tail.starts_with("[[") || asset;
            if wiki {
                let start = if asset { 3 } else { 2 };
                if let Some(end) = tail[start..].find("]]") {
                    let inside = &tail[start..start + end];
                    let (target, alias) = inside
                        .split_once('|')
                        .map_or((inside, None), |(a, b)| (a, Some(b)));
                    let length = start + end + 2;
                    if let Some(url) = resolve(target, asset)? {
                        if url.starts_with("/notes/") || asset {
                            out.push_str(&format!(
                                "{}[{}]({url})",
                                if asset { "!" } else { "" },
                                alias.unwrap_or(target)
                            ));
                        } else {
                            out.push_str(&format!(
                                "[[{url}{}]]",
                                alias.map_or(String::new(), |a| format!("|{a}"))
                            ));
                        }
                    } else {
                        out.push_str(&tail[..length]);
                    }
                    index += length;
                    continue;
                }
            }
            if tail.starts_with("![") || tail.starts_with('[') {
                let asset = tail.starts_with("![");
                let start = if asset { 2 } else { 1 };
                if let Some(end) = tail[start..].find("](") {
                    let href_start = start + end + 2;
                    if let Some(close) = tail[href_start..].find(')') {
                        let href = &tail[href_start..href_start + close];
                        let length = href_start + close + 1;
                        if let Some(url) = resolve(href, asset)? {
                            out.push_str(&format!(
                                "{}[{}]({url})",
                                if asset { "!" } else { "" },
                                &tail[start..start + end]
                            ));
                        } else {
                            out.push_str(&tail[..length]);
                        }
                        index += length;
                        continue;
                    }
                }
            }
            if comments && tail.starts_with("%%") {
                out.push_str("<!--");
                index += 2;
                comment = true;
                continue;
            }
            let ch = tail
                .chars()
                .next()
                .ok_or_else(|| Error::invalid("source", "invalid text"))?;
            out.push(ch);
            index += ch.len_utf8();
        }
    }
    if comment {
        out.push_str("-->");
    }
    Ok(out)
}
