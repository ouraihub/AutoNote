use crate::error::Error;
use crate::types::Millis;
use rusqlite::{Transaction, params};

pub(crate) fn snapshot(
    tx: &Transaction<'_>,
    id: &str,
    title: &str,
    content: &str,
    version_id: &str,
    now: Millis,
) -> Result<(), Error> {
    tx.execute("INSERT INTO note_versions(id,note_id,title,content,size,created_at) VALUES(?1,?2,?3,?4,?5,?6)", params![version_id,id,title,content,content.len() as i64,now.get()])?;
    tx.execute("DELETE FROM note_versions WHERE note_id=?1 AND id NOT IN (SELECT id FROM note_versions WHERE note_id=?1 ORDER BY created_at DESC,id DESC LIMIT 50)", [id])?;
    Ok(())
}
