use super::super::{CancellationToken, format};
use crate::Error;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};

pub(super) fn write_rows<T: serde::Serialize>(
    conn: &Connection,
    sql: &str,
    decode: fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    out: &mut dyn Write,
) -> Result<(), Error> {
    let mut stmt = conn.prepare(sql)?;
    let mut first = true;
    for raw in stmt.query_map([], decode)? {
        if !first {
            out.write_all(b",")?;
        }
        first = false;
        serde_json::to_writer(&mut *out, &raw?).map_err(|e| Error::Io(std::io::Error::other(e)))?;
    }
    Ok(())
}

pub(super) fn write_records(
    conn: &Connection,
    table: &str,
    out: &mut dyn Write,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    let mut stmt = conn.prepare(&format!("SELECT data FROM {table} ORDER BY rowid"))?;
    let mut first = true;
    for raw in stmt.query_map([], |r| r.get::<_, String>(0))? {
        cancel.check()?;
        if !first {
            out.write_all(b",")?;
        }
        first = false;
        out.write_all(raw?.as_bytes())?;
    }
    Ok(())
}

pub(super) fn folder_path(conn: &Connection, id: Option<&str>) -> Result<Vec<String>, Error> {
    let mut folder = Vec::new();
    let mut current = id.map(str::to_owned);
    while let Some(id) = current {
        if folder.len() >= 12 {
            return Err(format::invalid());
        }
        let (name, parent): (String, Option<String>) = conn.query_row(
            "SELECT name,parent_id FROM folders WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        folder.push(name);
        current = parent;
    }
    folder.reverse();
    format::folder_valid(&folder)?;
    Ok(folder)
}

pub(in crate::transfer) fn attachment_ids(content: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for (start, _) in content.match_indices("/api/files/") {
        if let Some(id) = content.get(start + 11..start + 37)
            && crate::id::is_valid_id(id)
            && !ids.iter().any(|v| v == id)
        {
            ids.push(id.to_owned());
        }
    }
    ids
}

pub(super) fn copy(
    input: &mut dyn Read,
    out: &mut dyn Write,
    cancel: &CancellationToken,
) -> Result<u64, Error> {
    let mut buf = [0u8; 65536];
    let mut count = 0;
    loop {
        cancel.check()?;
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
        count += n as u64;
    }
    Ok(count)
}

pub(in crate::transfer) fn hash_file(
    mut input: File,
    cancel: &CancellationToken,
) -> Result<String, Error> {
    let mut hash = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        cancel.check()?;
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(super) fn zip_error(_: zip::result::ZipError) -> Error {
    Error::invalid("format", "ZIP operation failed")
}

pub(in crate::transfer) fn safe_segment(value: &str) -> String {
    let s = crate::markdown::truncate_utf16(
        &value
            .chars()
            .map(|c| {
                if c.is_control() {
                    ' '
                } else if "\\/:*?\"<>|".contains(c) {
                    '-'
                } else {
                    c
                }
            })
            .collect::<String>(),
        80,
    )
    .trim_matches([' ', '.'])
    .to_owned();
    if s.is_empty() {
        "Untitled".to_owned()
    } else if format::safe_path(&s).is_err() {
        format!("_{s}")
    } else {
        s
    }
}

pub(in crate::transfer) fn url_path(path: &str) -> String {
    path.split('/')
        .map(|part| {
            let mut s = String::new();
            for b in part.bytes() {
                if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                    s.push(b as char);
                } else {
                    s.push_str(&format!("%{b:02X}"));
                }
            }
            s
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub(super) struct LimitedWriter<'a> {
    pub(super) file: &'a mut File,
    pub(super) bytes: u64,
    pub(super) max: u64,
}
impl Write for LimitedWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.bytes.saturating_add(buf.len() as u64) > self.max {
            return Err(std::io::Error::other("JSON bundle exceeds restore limit"));
        }
        let n = self.file.write(buf)?;
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}
