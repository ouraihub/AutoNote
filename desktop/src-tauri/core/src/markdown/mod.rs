//! Markdown analysis functions shared with the TypeScript implementation.
//!
//! These functions intentionally operate on UTF-8 Rust strings while matching
//! the TypeScript contract's UTF-16 limits and Unicode scalar semantics.

mod links;
mod references;
mod tags;
#[cfg(test)]
mod tests;
mod text;
pub use links::{WikiLink, extract_wiki_links, normalize_link_key, sha256_hex};
pub use references::attachment_references;
pub use tags::{extract_tags, sort_tag_names};
pub use text::{count_text, derive_excerpt, segment_cjk, to_plain_text, truncate_utf16};
pub(crate) use text::{
    fence_marker, strip_code_regions, strip_front_matter, strip_front_matter_with_tags,
    strip_html_comments, wiki_note_target,
};
