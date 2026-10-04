//! Log initialization and bounded runtime rotation.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::writer::MakeWriter;

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const LOG_BACKUPS: u8 = 2;

/// Writes logs to `path` (default level `info`, override with `RUST_LOG`).
pub fn init(path: &Path) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    rotate_if_needed(path);
    match RotatingWriter::new(path) {
        Ok(writer) => {
            let _ = tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_ansi(false)
                .with_writer(writer)
                .try_init();
        }
        Err(_) => {
            let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
        }
    }
}

struct RotatingWriter {
    state: Mutex<WriterState>,
}

struct WriterState {
    path: PathBuf,
    file: Option<File>,
    bytes: u64,
}

struct RotatingGuard<'a> {
    state: MutexGuard<'a, WriterState>,
}

impl RotatingWriter {
    fn new(path: &Path) -> io::Result<Self> {
        Ok(Self {
            state: Mutex::new(WriterState::new(path)?),
        })
    }
}

impl<'a> MakeWriter<'a> for RotatingWriter {
    type Writer = RotatingGuard<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        let state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        RotatingGuard { state }
    }
}

impl WriterState {
    fn new(path: &Path) -> io::Result<Self> {
        let file = open_log(path)?;
        let bytes = file.metadata()?.len();
        Ok(Self {
            path: path.to_path_buf(),
            file: Some(file),
            bytes,
        })
    }

    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if self.file.is_none() {
            self.file = open_log(&self.path).ok();
            self.bytes = self
                .file
                .as_ref()
                .and_then(|file| file.metadata().ok())
                .map_or(0, |metadata| metadata.len());
        }
        let Some(file) = self.file.as_mut() else {
            return Err(io::Error::other("log file unavailable"));
        };
        let written = file.write(buffer)?;
        self.bytes += written as u64;
        Ok(written)
    }

    fn rotate(&mut self) {
        // Taking the handle first is required on Windows, where rename fails while open.
        let _ = self.file.take();
        let _ = rotate_files(&self.path);
        self.file = open_log(&self.path).ok();
        self.bytes = self
            .file
            .as_ref()
            .and_then(|file| file.metadata().ok())
            .map_or(0, |metadata| metadata.len());
    }
}

impl Write for RotatingGuard<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.state.write(buffer)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.state.file.as_mut().map_or(Ok(()), File::flush)
    }
}

impl Drop for RotatingGuard<'_> {
    fn drop(&mut self) {
        // Rotate between tracing events, never halfway through a formatted line.
        if self.state.bytes >= MAX_LOG_BYTES {
            self.state.rotate();
        }
    }
}

fn open_log(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

fn rotate_if_needed(path: &Path) {
    if std::fs::metadata(path).is_ok_and(|metadata| metadata.len() >= MAX_LOG_BYTES) {
        let _ = rotate_files(path);
    }
}

fn rotate_files(path: &Path) -> io::Result<()> {
    for number in (1..=LOG_BACKUPS).rev() {
        let source = if number == 1 {
            path.to_path_buf()
        } else {
            rotated_path(path, number - 1)
        };
        let destination = rotated_path(path, number);
        if let Err(error) = std::fs::remove_file(&destination)
            && error.kind() != io::ErrorKind::NotFound
        {
            return Err(error);
        }
        if let Err(error) = std::fs::rename(&source, &destination)
            && error.kind() != io::ErrorKind::NotFound
        {
            return Err(error);
        }
    }
    Ok(())
}

fn rotated_path(path: &Path, number: u8) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("autonote.log");
    path.with_file_name(format!("{name}.{number}"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "a failed unwrap is a failed test")]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn runtime_rotation_keeps_two_backups_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("autonote.log");
        let writer = RotatingWriter::new(&path).unwrap();
        for byte in [b'a', b'b', b'c'] {
            writer
                .make_writer()
                .write_all(&vec![byte; MAX_LOG_BYTES as usize])
                .unwrap();
        }
        assert_eq!(std::fs::read(rotated_path(&path, 1)).unwrap()[0], b'c');
        assert_eq!(std::fs::read(rotated_path(&path, 2)).unwrap()[0], b'b');
        assert!(!rotated_path(&path, 3).exists());
        assert!(path.exists());
    }
}
