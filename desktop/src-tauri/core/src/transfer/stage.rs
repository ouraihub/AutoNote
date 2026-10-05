use super::format::{ENTRY_MAX, EXPANDED_MAX, UPLOAD_MAX, safe_path};
use super::{CancellationToken, ProgressSink, TransferService};
use crate::Error;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::Dir;
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub enum AuthorizedInput {
    Files(Vec<(String, File)>),
    Folder(Dir),
}
impl AuthorizedInput {
    /// Only native code calls this after the user confirms the selected path.
    /// # Errors
    /// Rejects unsafe names, links, non-files and selections above the file limit.
    pub fn open_files(paths: Vec<PathBuf>) -> Result<Self, Error> {
        if paths.len() > 500 {
            return Err(Error::invalid("source", "too many files"));
        }
        let mut result = Vec::new();
        for path in paths {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| Error::invalid("source", "invalid filename"))?
                .to_owned();
            safe_path(&name)?;
            let parent = path
                .parent()
                .ok_or_else(|| Error::invalid("source", "invalid selected file"))?;
            let dir = Dir::open_ambient_dir(parent, cap_std::ambient_authority())?;
            result.push((name.clone(), open_file(&dir, &name)?));
        }
        Ok(Self::Files(result))
    }
    /// Opens a native-selected directory without following its final component.
    /// # Errors
    /// Rejects linked/reparse roots and unavailable directories.
    pub fn open_folder(path: &Path) -> Result<Self, Error> {
        let parent = path
            .parent()
            .ok_or_else(|| Error::invalid("source", "select a non-root folder"))?;
        let name = path
            .file_name()
            .ok_or_else(|| Error::invalid("source", "invalid folder"))?;
        let dir = Dir::open_ambient_dir(parent, cap_std::ambient_authority())?;
        let selected = dir.open_dir_nofollow(name)?;
        reject_reparse(&selected.try_clone()?.into_std_file().metadata()?)?;
        Ok(Self::Folder(selected))
    }
}
pub struct AuthorizedOutput {
    directory: Dir,
    filename: String,
    space_path: PathBuf,
}
impl AuthorizedOutput {
    /// Opens the target directory after the native save dialog confirms replacement.
    /// # Errors
    /// Rejects unsafe names and unavailable directories.
    pub fn open(path: &Path) -> Result<Self, Error> {
        let parent = path
            .parent()
            .ok_or_else(|| Error::invalid("format", "invalid output"))?;
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| Error::invalid("format", "invalid output"))?
            .to_owned();
        safe_path(&filename)?;
        Ok(Self {
            directory: Dir::open_ambient_dir(parent, cap_std::ambient_authority())?,
            filename,
            space_path: parent.to_owned(),
        })
    }
    /// Creates an exclusive same-directory temporary output.
    /// # Errors
    /// Returns insufficient-space or filesystem errors.
    pub fn partial(&self, nonce: &str) -> Result<(String, File), Error> {
        if fs2::available_space(&self.space_path)? < 1024 * 1024 {
            return Err(std::io::Error::from(std::io::ErrorKind::StorageFull).into());
        }
        let name = format!(".autonote-{nonce}.partial");
        let mut options = cap_std::fs::OpenOptions::new();
        options
            .write(true)
            .read(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        Ok((
            name.clone(),
            self.directory.open_with(name, &options)?.into_std(),
        ))
    }
    /// Publishes the fully synced output using the platform's same-volume rename.
    /// # Errors
    /// Returns publication errors; the old target has not been truncated.
    pub fn publish(&self, partial: &str) -> Result<(), Error> {
        // The save dialog has already obtained replacement authorization. A same-directory
        // rename replaces atomically on supported hosts; failure leaves the old target intact.
        self.directory
            .rename(partial, &self.directory, &self.filename)?;
        #[cfg(not(windows))]
        self.directory.try_clone()?.into_std_file().sync_all()?;
        Ok(())
    }
    /// Removes this output's own unpublished partial file.
    /// # Errors
    /// Returns filesystem cleanup errors.
    pub fn remove(&self, partial: &str) -> Result<(), Error> {
        self.directory.remove_file(partial)?;
        Ok(())
    }
}
fn open_file(dir: &Dir, name: &str) -> Result<File, Error> {
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let opened = dir.open_with(name, &options)?;
    if cap_fs_ext::MetadataExt::nlink(&opened.metadata()?) > 1 {
        return Err(Error::invalid(
            "source",
            "hard-linked input is not permitted",
        ));
    }
    let file = opened.into_std();
    reject_reparse(&file.metadata()?)?;
    if !file.metadata()?.is_file() {
        return Err(Error::invalid("source", "not a regular file"));
    }
    Ok(file)
}
pub(crate) fn reject_reparse(metadata: &std::fs::Metadata) -> Result<(), Error> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(Error::invalid("source", "reparse point is not permitted"));
        }
    }
    if metadata.file_type().is_symlink() {
        return Err(Error::invalid("source", "linked input is not permitted"));
    }
    Ok(())
}
pub(super) struct Stage {
    pub db: Connection,
    pub directory: tempfile::TempDir,
}
impl Stage {
    pub fn new(service: &TransferService) -> Result<Self, Error> {
        let root = service
            .library
            .files
            .transfer_root()
            .parent()
            .ok_or_else(|| Error::invalid("source", "missing data directory"))?
            .join("staging")
            .join("import");
        std::fs::create_dir_all(&root)?;
        reject_reparse(&std::fs::symlink_metadata(&root)?)?;
        if fs2::available_space(&root)? < 1024 * 1024 {
            return Err(std::io::Error::from(std::io::ErrorKind::StorageFull).into());
        }
        let directory = tempfile::Builder::new()
            .prefix("transfer-")
            .tempdir_in(root)?;
        let db = Connection::open(directory.path().join("plan.sqlite"))?;
        db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE entries(path TEXT PRIMARY KEY COLLATE NOCASE,object TEXT NOT NULL,size INTEGER NOT NULL,hash TEXT NOT NULL); CREATE TABLE notes(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE attachments(hash TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE mappings(source TEXT PRIMARY KEY,target TEXT NOT NULL); CREATE TABLE warnings(message TEXT); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);")?;
        db.execute_batch("CREATE TABLE path_keys(key TEXT PRIMARY KEY);")?;
        db.execute_batch("CREATE TABLE published(id TEXT PRIMARY KEY,hash TEXT NOT NULL);")?;
        db.execute("INSERT INTO metadata VALUES('job',?1)", [&service.job_id])?;
        Ok(Self { directory, db })
    }
    pub fn object(&self, object: &str) -> PathBuf {
        self.directory.path().join(object)
    }
    pub fn phase(&self, phase: &str) -> Result<(), Error> {
        self.db.execute(
            "INSERT OR REPLACE INTO metadata VALUES('phase',?1)",
            [phase],
        )?;
        Ok(())
    }
    pub fn cleanup_published(&self, library: &crate::Library) -> Result<(), Error> {
        library.read(|conn| {
            let mut published = self.db.prepare("SELECT id FROM published")?;
            for raw in published.query_map([], |r| r.get::<_, String>(0))? {
                let id = raw?;
                if !crate::id::is_valid_id(&id) { return Err(Error::invalid("source", "invalid publication journal")) }
                let used: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM attachments WHERE id=?1) OR EXISTS(SELECT 1 FROM notes WHERE instr(content,?2)>0) OR EXISTS(SELECT 1 FROM note_versions WHERE instr(content,?2)>0)", params![id,format!("/api/files/{id}")], |r| r.get(0))?;
                if !used {
                    let path = library.files.transfer_root().join(&id);
                    match std::fs::remove_file(path) {
                        Ok(()) => (),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                        Err(error) => return Err(error.into()),
                    }
                }
            }
            Ok(())
        })
    }
    pub(super) fn sql_size(size: u64) -> Result<i64, Error> {
        i64::try_from(size).map_err(|_| Error::invalid("size", "exceeds SQLite integer range"))
    }

    pub fn put(
        &self,
        path: &str,
        reader: &mut dyn Read,
        max: u64,
        cancel: &CancellationToken,
    ) -> Result<u64, Error> {
        safe_path(path)?;
        self.reserve_path(path)?;
        let object: String = self
            .db
            .query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.object(&object))?;
        let mut hash = Sha256::new();
        let mut size = 0u64;
        let mut bytes = [0u8; 64 * 1024];
        loop {
            cancel.check()?;
            let read = reader.read(&mut bytes)?;
            if read == 0 {
                break;
            }
            size = size.checked_add(read as u64).ok_or(Error::TooLarge {
                field: "source",
                limit: max,
            })?;
            if size > max {
                return Err(Error::TooLarge {
                    field: "source",
                    limit: max,
                });
            }
            hash.update(&bytes[..read]);
            file.write_all(&bytes[..read])?;
        }
        file.sync_all()?;
        let sql_size = Self::sql_size(size)?;
        self.db
            .execute(
                "INSERT INTO entries VALUES(?1,?2,?3,?4)",
                params![path, object, sql_size, format!("{:x}", hash.finalize())],
            )
            .map_err(|_| Error::invalid("source", "duplicate or invalid archive entry"))?;
        Ok(size)
    }
    pub fn entry(&self, path: &str) -> Result<(File, u64, String), Error> {
        let (object, size, hash): (String, i64, String) = self
            .db
            .query_row(
                "SELECT object,size,hash FROM entries WHERE path=?1",
                [path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| Error::invalid("source", "missing referenced payload"))?;
        let size = u64::try_from(size)
            .map_err(|_| Error::invalid("size", "must be a non-negative integer"))?;
        Ok((File::open(self.object(&object))?, size, hash))
    }
    fn reserve_path(&self, path: &str) -> Result<(), Error> {
        self.db
            .execute("INSERT INTO path_keys VALUES(?1)", [path.to_lowercase()])
            .map_err(|_| Error::invalid("source", "case-folded duplicate entry"))?;
        Ok(())
    }
    pub fn ingest(
        &self,
        input: AuthorizedInput,
        service: &TransferService,
        progress: &dyn ProgressSink,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        let mut completed = 0;
        let estimate = match &input {
            AuthorizedInput::Files(files) => {
                files
                    .iter()
                    .try_fold(0u64, |total, (_, file)| -> Result<u64, Error> {
                        Ok(total.saturating_add(file.metadata()?.len()))
                    })?
            }
            AuthorizedInput::Folder(dir) => folder_bytes(dir, 0, cancel)?,
        };
        if fs2::available_space(self.directory.path())?
            < estimate.saturating_mul(3).saturating_add(8 * 1024 * 1024)
        {
            return Err(std::io::Error::from(std::io::ErrorKind::StorageFull).into());
        }
        match input {
            AuthorizedInput::Folder(dir) => {
                self.folder(&dir, "", &mut completed, service, progress, cancel)?
            }
            AuthorizedInput::Files(files) => {
                let mut uploaded = 0u64;
                let mut expanded = 0u64;
                let mut entry_count = 0usize;
                for (name, mut file) in files {
                    uploaded = uploaded.saturating_add(file.metadata()?.len());
                    if uploaded > UPLOAD_MAX {
                        return Err(Error::TooLarge {
                            field: "source",
                            limit: UPLOAD_MAX,
                        });
                    }
                    if name.to_lowercase().ends_with(".zip") {
                        let mut zip = zip::ZipArchive::new(file).map_err(|_| {
                            Error::invalid(
                                "source",
                                "invalid ZIP; extract large backups and select folder",
                            )
                        })?;
                        entry_count = entry_count.saturating_add(zip.len());
                        if entry_count > ENTRY_MAX {
                            return Err(Error::invalid("source", "too many ZIP entries"));
                        }
                        for index in 0..zip.len() {
                            cancel.check()?;
                            let mut entry = zip.by_index(index).map_err(|_| {
                                Error::invalid("source", "encrypted or corrupt ZIP entry")
                            })?;
                            if !matches!(
                                entry.compression(),
                                zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
                            ) {
                                return Err(Error::invalid(
                                    "source",
                                    "unsupported ZIP compression",
                                ));
                            }
                            if entry.unix_mode().is_some_and(|m| {
                                m & 0o170000 != 0
                                    && m & 0o170000 != 0o100000
                                    && m & 0o170000 != 0o040000
                            }) {
                                return Err(Error::invalid("source", "special ZIP entry"));
                            }
                            if entry.is_dir() {
                                let path = entry.name().trim_end_matches('/');
                                safe_path(path)?;
                                self.reserve_path(path)?;
                                continue;
                            }
                            let path = entry.name().to_owned();
                            let declared = entry.size();
                            if declared > EXPANDED_MAX.saturating_sub(expanded) {
                                return Err(Error::TooLarge {
                                    field: "source",
                                    limit: EXPANDED_MAX,
                                });
                            }
                            let actual = self.put(
                                &path,
                                &mut entry,
                                EXPANDED_MAX.saturating_sub(expanded),
                                cancel,
                            )?;
                            if actual != declared {
                                return Err(Error::invalid("source", "ZIP length mismatch"));
                            }
                            expanded += actual;
                            completed += actual;
                            service.progress(progress, crate::ProgressPhase::Reading, completed);
                        }
                    } else {
                        let max = if name.to_lowercase().ends_with(".json") {
                            super::format::BUNDLE_MAX
                        } else {
                            UPLOAD_MAX
                        };
                        completed += self.put(&name, &mut file, max, cancel)?;
                        service.progress(progress, crate::ProgressPhase::Reading, completed);
                    }
                }
            }
        }
        self.db.execute_batch("CREATE TABLE input_paths(path TEXT PRIMARY KEY); INSERT INTO input_paths SELECT path FROM entries;")?;
        Ok(())
    }
    fn folder(
        &self,
        dir: &Dir,
        prefix: &str,
        completed: &mut u64,
        service: &TransferService,
        progress: &dyn ProgressSink,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        for entry in dir.entries()? {
            cancel.check()?;
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| Error::invalid("source", "non UTF-8 path"))?;
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            safe_path(&path)?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                return Err(Error::invalid("source", "linked vault entry"));
            }
            if kind.is_dir() {
                if prefix.split('/').count() > 32 {
                    return Err(Error::invalid("source", "directory nesting too deep"));
                }
                let child = dir.open_dir_nofollow(&name)?;
                reject_reparse(&child.try_clone()?.into_std_file().metadata()?)?;
                self.folder(&child, &path, completed, service, progress, cancel)?;
            } else if kind.is_file() {
                let mut file = open_file(dir, &name)?;
                let max = if name == "manifest.json" {
                    u64::MAX - 1
                } else {
                    super::format::ITEM_MAX
                };
                *completed += self.put(&path, &mut file, max, cancel)?;
                service.progress(progress, crate::ProgressPhase::Reading, *completed);
            } else {
                return Err(Error::invalid("source", "special vault entry"));
            }
        }
        Ok(())
    }
}

fn folder_bytes(dir: &Dir, depth: usize, cancel: &CancellationToken) -> Result<u64, Error> {
    if depth > 32 {
        return Err(Error::invalid("source", "directory nesting too deep"));
    }
    let mut total = 0u64;
    for entry in dir.entries()? {
        cancel.check()?;
        let entry = entry?;
        let name = entry.file_name();
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(Error::invalid("source", "linked vault entry"));
        }
        if kind.is_dir() {
            let child = dir.open_dir_nofollow(&name)?;
            reject_reparse(&child.try_clone()?.into_std_file().metadata()?)?;
            total = total.saturating_add(folder_bytes(&child, depth + 1, cancel)?);
        } else if kind.is_file() {
            let name = name
                .into_string()
                .map_err(|_| Error::invalid("source", "non UTF-8 path"))?;
            total = total.saturating_add(open_file(dir, &name)?.metadata()?.len());
        } else {
            return Err(Error::invalid("source", "special vault entry"));
        }
    }
    Ok(total)
}
