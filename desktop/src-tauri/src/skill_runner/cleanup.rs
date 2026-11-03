use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::{Snapshot, failure, safe_relative};

pub(crate) struct Workspace(pub(crate) PathBuf);
impl Drop for Workspace {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            tracing::warn!(error = %error, "skill.run.cleanup_failed");
        }
    }
}

fn directory(path: &Path) -> std::io::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    let link = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let link = metadata.file_type().is_symlink();
    if !metadata.is_dir() || link {
        return Err(std::io::Error::other("linked staging directory rejected"));
    }
    Ok(())
}

pub(crate) fn materialize(root: &Path, snapshot: &Snapshot) -> Result<Workspace, super::ToolError> {
    let write = || -> std::io::Result<Workspace> {
        let root = fs::canonicalize(root)?;
        let staging = root.join("staging");
        directory(&staging)?;
        let staging = staging.join("skill-runs");
        directory(&staging)?;
        let path = staging.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&path)?;
        let workspace = Workspace(path);
        for (relative, content) in &snapshot.files {
            if !safe_relative(relative) {
                return Err(std::io::Error::other("invalid packaged file path"));
            }
            let target = workspace.0.join(relative);
            let parent = target
                .parent()
                .ok_or_else(|| std::io::Error::other("file parent missing"))?;
            let mut current = workspace.0.clone();
            for component in parent
                .strip_prefix(&workspace.0)
                .map_err(std::io::Error::other)?
                .components()
            {
                current.push(component);
                directory(&current)?;
            }
            if !fs::canonicalize(parent)?.starts_with(&workspace.0) {
                return Err(std::io::Error::other("packaged file escapes staging"));
            }
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)?
                .write_all(content)?;
        }
        Ok(workspace)
    };
    write().map_err(|error| failure("materialize_failed", error, false))
}
