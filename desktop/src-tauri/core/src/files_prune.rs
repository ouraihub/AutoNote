use super::*;

impl Library {
    pub fn files_prune(&self) -> Result<crate::dto::PruneResult, Error> {
        const UNREFERENCED: &str = "NOT EXISTS (SELECT 1 FROM notes WHERE \
            instr(content, '/api/files/' || attachments.id)>0) AND NOT EXISTS (SELECT 1 \
            FROM note_versions WHERE instr(content, '/api/files/' || attachments.id)>0)";
        let sessions = self.files.sessions.lock()?;
        let result = {
            let conn = self.conn.lock()?;
            let freed: i64 = conn.query_row(
                &format!("SELECT COALESCE(SUM(size),0) FROM attachments WHERE {UNREFERENCED}"),
                [],
                |r| r.get(0),
            )?;
            let removed = conn
                .execute(&format!("DELETE FROM attachments WHERE {UNREFERENCED}"), [])?
                as u64;
            crate::dto::PruneResult {
                removed,
                freed_bytes: freed as u64,
            }
        };
        drop(sessions);
        self.files_recover()?;
        Ok(result)
    }
}
