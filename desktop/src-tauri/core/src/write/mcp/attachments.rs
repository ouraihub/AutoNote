use super::*;

pub(super) fn upload_attachment(
    library: &Library,
    w: &mut WriteTx<'_>,
    args: &Value,
) -> Result<Value, Error> {
    Ok({
        let aid = args
            .get("attachment_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or(w.id()?);
        let bytes = decode_base64(s(args, "data")?)?;
        let file = library.files.mcp_publish(
            &w.tx,
            (&aid, args.get("note_id").and_then(Value::as_str)),
            s(args, "filename")?,
            s(args, "mime")?,
            &bytes,
            w.now.get(),
        )?;
        output(file)?
    })
}

pub(super) fn delete_attachment(w: &mut WriteTx<'_>, args: &Value) -> Result<Value, Error> {
    Ok({
        let aid = id(args, "attachment_id")?;
        let referenced: bool = w.tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM notes WHERE instr(content,?1)>0 \
UNION ALL SELECT 1 FROM note_versions WHERE instr(content,?1)>0)",
            [format!("/api/files/{aid}")],
            |r| r.get(0),
        )?;
        if referenced {
            return Err(Error::invalid("attachment_id", "attachment is referenced"));
        }
        if w.tx
            .execute("DELETE FROM attachments WHERE id=?1", [aid.as_str()])?
            == 0
        {
            return Err(Error::NotFound {
                entity: Entity::Attachment,
                id: aid,
            });
        }
        json!({"ok":true,"attachment_id":aid})
    })
}
