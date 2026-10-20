//! Platform credential protection; Windows keeps the original current-user DPAPI format.
#![cfg_attr(windows, allow(unsafe_code))]

use note_core::{AppError, ErrorCode};
use note_sync::SecretStore;

#[derive(Default)]
pub struct PlatformSecretStore;

impl SecretStore for PlatformSecretStore {
    fn protect(&self, value: &[u8]) -> Result<Vec<u8>, AppError> {
        crypt(value, true)
    }

    fn unprotect(&self, value: &[u8]) -> Result<Vec<u8>, AppError> {
        crypt(value, false)
    }
}

#[cfg(windows)]
fn unavailable() -> AppError {
    AppError::new(
        ErrorCode::StorageUnavailable,
        "Windows DPAPI credentials unavailable",
    )
}

#[cfg(not(windows))]
fn crypt(value: &[u8], protect: bool) -> Result<Vec<u8>, AppError> {
    if protect {
        aether_providers::secrets::protect(value)
    } else {
        aether_providers::secrets::unprotect(value).map(|mut secret| std::mem::take(&mut *secret))
    }
    .map_err(|_| {
        AppError::new(
            ErrorCode::StorageUnavailable,
            "System credential store unavailable or credential unreadable",
        )
    })
}

#[cfg(windows)]
fn crypt(value: &[u8], protect: bool) -> Result<Vec<u8>, AppError> {
    use std::{ffi::c_void, ptr};
    use zeroize::Zeroize;

    #[repr(C)]
    struct Blob {
        len: u32,
        data: *mut u8,
    }

    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    impl Drop for Blob {
        fn drop(&mut self) {
            if !self.data.is_null() {
                // SAFETY: only DPAPI's output blob has this destructor. Windows allocated
                // exactly len bytes with LocalAlloc; erase them before the matching LocalFree.
                unsafe {
                    std::slice::from_raw_parts_mut(self.data, self.len as usize).zeroize();
                    LocalFree(self.data.cast());
                }
            }
        }
    }

    // Cookies are small; bound both FFI length conversion and malformed persisted input.
    if value.len() > 65_536 {
        return Err(AppError::new(
            ErrorCode::BadRequest,
            "Credential exceeds size limit",
        ));
    }
    let mut output = Blob {
        len: 0,
        data: ptr::null_mut(),
    };
    // ManuallyDrop prevents freeing the borrowed input, whose pointer DPAPI only reads.
    let input = std::mem::ManuallyDrop::new(Blob {
        len: value.len() as u32,
        data: value.as_ptr().cast_mut(),
    });
    // SAFETY: input borrows a live slice for this synchronous call; Windows only reads it.
    // All optional pointers are null. output is writable and freed/erased by its destructor.
    // CRYPTPROTECT_UI_FORBIDDEN avoids prompts; no machine scope or insecure fallback.
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &*input,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &*input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                1,
                &mut output,
            )
        }
    };
    if ok == 0 || output.data.is_null() {
        return Err(unavailable());
    }
    // SAFETY: successful DPAPI allocated the output and reports its valid byte length.
    // The returned plaintext belongs to the caller; the transient Windows buffer is erased.
    Ok(unsafe { std::slice::from_raw_parts(output.data, output.len as usize) }.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_boundary() -> Result<(), AppError> {
        let store = PlatformSecretStore;
        #[cfg(windows)]
        {
            use zeroize::Zeroizing;
            let secret = Zeroizing::new(b"session-boundary-secret".to_vec());
            let encrypted = store.protect(&secret)?;
            assert_ne!(encrypted, *secret);
            let decrypted = Zeroizing::new(store.unprotect(&encrypted)?);
            assert_eq!(*decrypted, *secret);
            assert!(store.unprotect(b"not-a-DPAPI-blob").is_err());
        }
        #[cfg(not(windows))]
        {
            assert!(store.unprotect(b"not-a-platform-blob").is_err());
        }
        Ok(())
    }
}
