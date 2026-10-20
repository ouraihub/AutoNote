//! Native OS-store smoke: separate seal/open processes share only encrypted fixture bytes.
use autonote_shell::credentials::PlatformSecretStore;
use note_sync::SecretStore;

const SYNC_BYTES: &[u8] = b"autonote-sync-smoke\0\xff";
const API_BYTES: &[u8] = b"autonote-provider-smoke";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let action = args
        .get(1)
        .ok_or("missing seal/open/tamper/forget action")?;
    let file = std::path::PathBuf::from(args.get(2).ok_or("missing encrypted fixture path")?);
    let store = PlatformSecretStore;
    match action.as_str() {
        "seal" => {
            let sync = store.protect(SYNC_BYTES)?;
            let provider = aether_providers::secrets::protect(API_BYTES)?;
            if sync
                .windows(SYNC_BYTES.len())
                .any(|bytes| bytes == SYNC_BYTES)
                || provider
                    .windows(API_BYTES.len())
                    .any(|bytes| bytes == API_BYTES)
            {
                return Err("plaintext present in sealed fixture".into());
            }
            std::fs::write(file, serde_json::to_vec(&(sync, provider))?)?;
        }
        "open" => {
            let (sync, provider): (Vec<u8>, Vec<u8>) =
                serde_json::from_slice(&std::fs::read(file)?)?;
            let restored = zeroize::Zeroizing::new(store.unprotect(&sync)?);
            if restored.as_slice() != SYNC_BYTES
                || aether_providers::secrets::unprotect(&provider)?.as_slice() != API_BYTES
            {
                return Err("persisted native secret differs".into());
            }
        }
        "tamper" => {
            let (mut sync, mut provider): (Vec<u8>, Vec<u8>) =
                serde_json::from_slice(&std::fs::read(file)?)?;
            *sync.last_mut().ok_or("empty sync ciphertext")? ^= 1;
            *provider.last_mut().ok_or("empty provider ciphertext")? ^= 1;
            if store.unprotect(&sync).is_ok()
                || aether_providers::secrets::unprotect(&provider).is_ok()
            {
                return Err("tampered secret accepted".into());
            }
        }
        "forget" => std::fs::remove_file(file)?,
        _ => return Err("unknown action".into()),
    }
    Ok(())
}
