//! Cookie policy for the existing Web session protocol; no persistent cookie jar.

use cookie::{Cookie, SameSite};
use note_core::{AppError, ErrorCode, Millis};
use serde::{Deserialize, Serialize};
use std::fmt;
use url::{Host, Url};
use zeroize::Zeroize;

/// Serialized only into the OS secret store, never returned through IPC.
#[derive(Serialize, Deserialize)]
pub struct CookieRecord {
    pub header: String,
    pub domain: String,
    pub path: String,
    pub expires_at: Option<i64>,
    pub secure: bool,
    pub host_only: bool,
    pub name: String,
    pub same_site: String,
}
impl Drop for CookieRecord {
    fn drop(&mut self) {
        self.header.zeroize();
    }
}
impl Drop for SessionCookie {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

fn invalid() -> AppError {
    AppError::new(ErrorCode::BadRequest, "Invalid sync origin")
}

fn rejected_cookie() -> AppError {
    AppError::new(ErrorCode::InvalidResponse, "Invalid session cookie")
}

/// A configured HTTP(S) origin, without credentials, query, fragment or subpath.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteOrigin(Url);

impl SiteOrigin {
    /// Validate and normalize an origin before using it for authentication.
    ///
    /// # Errors
    /// Returns `bad_request` for a non-HTTP origin, non-origin URL, or plain
    /// `http` to anything but loopback (credentials would travel in cleartext).
    pub fn parse(value: &str) -> Result<Self, AppError> {
        if value.trim() != value || value.bytes().any(|b| b.is_ascii_control()) {
            return Err(invalid());
        }
        let url = Url::parse(value).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || (url.scheme() == "http"
                && !matches!(url.host(), Some(Host::Domain("localhost")))
                && !matches!(url.host(), Some(Host::Ipv4(ip)) if ip.is_loopback())
                && !matches!(url.host(), Some(Host::Ipv6(ip)) if ip.is_loopback()))
        {
            return Err(invalid());
        }
        Ok(Self(url))
    }

    /// Canonical URL of the configured site.
    #[must_use]
    pub fn as_url(&self) -> &Url {
        &self.0
    }

    /// Validate a request or redirect target against the exact configured origin.
    /// The caller must disable automatic redirects and never forward a write body.
    ///
    /// # Errors
    /// Returns `forbidden` for credentials, scheme/host/port changes or fragments.
    pub fn check_target(&self, target: &Url) -> Result<(), AppError> {
        if target.origin() != self.0.origin()
            || !target.username().is_empty()
            || target.password().is_some()
            || target.fragment().is_some()
        {
            return Err(AppError::new(
                ErrorCode::Forbidden,
                "Sync target is not same-origin",
            ));
        }
        Ok(())
    }
}

/// Session cookie metadata. The secret is never included in its `Debug` output.
pub struct SessionCookie {
    origin: SiteOrigin,
    name: String,
    value: String,
    domain: String,
    path: String,
    expires_at: Option<i64>,
    secure: bool,
    http_only: bool,
    host_only: bool,
    same_site: SameSite,
}

impl fmt::Debug for SessionCookie {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionCookie")
            .field("name", &self.name)
            .field("domain", &self.domain)
            .field("path", &self.path)
            .field("expires_at", &self.expires_at)
            .field("secure", &self.secure)
            .field("http_only", &self.http_only)
            .field("host_only", &self.host_only)
            .field("same_site", &self.same_site)
            .finish_non_exhaustive()
    }
}

impl SessionCookie {
    /// Parse one `Set-Cookie` returned by the configured origin.
    /// Only the two session names used by the existing Web server are accepted.
    ///
    /// # Errors
    /// Returns `forbidden` for a foreign response and `invalid_response` for
    /// malformed cookies, unsafe prefixes or an unrelated domain.
    pub fn parse(
        origin: &SiteOrigin,
        response_url: &Url,
        header: &str,
        now: Millis,
    ) -> Result<Self, AppError> {
        origin.check_target(response_url)?;
        if header.len() > 4096 || header.bytes().any(|b| b.is_ascii_control()) {
            return Err(rejected_cookie());
        }
        let cookie = Cookie::parse(header).map_err(|_| rejected_cookie())?;
        if !matches!(
            cookie.name(),
            "autonote_session" | "__Host-autonote_session"
        ) || !cookie
            .value()
            .bytes()
            .all(|b| matches!(b, 0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e))
        {
            return Err(rejected_cookie());
        }
        validate_attributes(header, &cookie)?;
        let host = response_url.host_str().ok_or_else(rejected_cookie)?;
        let host_only = cookie.domain().is_none();
        let domain = cookie.domain().unwrap_or(host).to_ascii_lowercase();
        let domain_matches = domain == host
            || matches!(response_url.host(), Some(Host::Domain(_)))
                && host
                    .strip_suffix(&domain)
                    .is_some_and(|prefix| prefix.ends_with('.'));
        if domain.is_empty() || !domain_matches || domain.ends_with('.') {
            return Err(rejected_cookie());
        }
        let path = cookie
            .path()
            .filter(|path| path.starts_with('/'))
            .unwrap_or_else(|| default_path(response_url.path()))
            .to_owned();
        let secure = cookie.secure().unwrap_or(false);
        let http_only = cookie.http_only().unwrap_or(false);
        let same_site = cookie.same_site().unwrap_or(SameSite::Lax);
        if secure && response_url.scheme() != "https"
            || same_site == SameSite::None && !secure
            || cookie.name().starts_with("__Host-")
                && (!secure || !host_only || cookie.path() != Some("/"))
        {
            return Err(rejected_cookie());
        }
        let expires_at = if let Some(age) = cookie.max_age() {
            Some(if age.whole_seconds() <= 0 {
                now.get()
            } else {
                now.get()
                    .checked_add(
                        age.whole_seconds()
                            .checked_mul(1000)
                            .ok_or_else(rejected_cookie)?,
                    )
                    .ok_or_else(rejected_cookie)?
            })
        } else {
            cookie
                .expires_datetime()
                .map(|date| {
                    date.unix_timestamp()
                        .checked_mul(1000)
                        .ok_or_else(rejected_cookie)
                })
                .transpose()?
        };
        Ok(Self {
            origin: origin.clone(),
            name: cookie.name().to_owned(),
            value: cookie.value().to_owned(),
            domain,
            path,
            expires_at,
            secure,
            http_only,
            host_only,
            same_site,
        })
    }

    /// Whether the server's deadline has passed (including a deletion cookie).
    #[must_use]
    pub fn is_expired(&self, now: Millis) -> bool {
        self.value.is_empty() || self.expires_at.is_some_and(|expiry| expiry <= now.get())
    }

    /// Build the sole `Cookie` header only for an eligible same-origin request.
    /// An expired cookie returns `None`; its owner must then discard it.
    ///
    /// # Errors
    /// Returns `forbidden` if the request leaves the configured origin.
    pub fn request_header(&self, target: &Url, now: Millis) -> Result<Option<String>, AppError> {
        self.origin.check_target(target)?;
        if self.is_expired(now)
            || self.secure && target.scheme() != "https"
            || !path_matches(&self.path, target.path())
        {
            return Ok(None);
        }
        Ok(Some(format!("{}={}", self.name, self.value)))
    }
    /// Serializes this session cookie for protected storage.
    ///
    /// # Errors
    /// Returns an error if cookie metadata cannot be serialized safely.
    pub fn record(&self) -> Result<CookieRecord, AppError> {
        let mut header = format!(
            "{}={}; Path={}; SameSite={}",
            self.name, self.value, self.path, self.same_site
        );
        if !self.host_only {
            header.push_str(&format!("; Domain={}", self.domain));
        }
        if self.secure {
            header.push_str("; Secure");
        }
        if self.http_only {
            header.push_str("; HttpOnly");
        }
        Ok(CookieRecord {
            header,
            domain: self.domain.clone(),
            path: self.path.clone(),
            expires_at: self.expires_at,
            secure: self.secure,
            host_only: self.host_only,
            name: self.name.clone(),
            same_site: self.same_site.to_string(),
        })
    }

    /// Restores a session cookie from protected storage.
    ///
    /// # Errors
    /// Returns an error if the record is malformed, mismatched, or expired.
    pub fn from_record(
        origin: &SiteOrigin,
        record: &CookieRecord,
        now: Millis,
    ) -> Result<Self, AppError> {
        let mut cookie = Self::parse(origin, origin.as_url(), &record.header, now)?;
        if cookie.domain != record.domain
            || cookie.path != record.path
            || cookie.secure != record.secure
            || cookie.host_only != record.host_only
            || cookie.name != record.name
            || cookie.same_site.to_string() != record.same_site
            || record
                .expires_at
                .is_some_and(|expiry| !(0..=note_core::MAX_SAFE_INTEGER).contains(&expiry))
        {
            return Err(rejected_cookie());
        }
        cookie.expires_at = record.expires_at;
        if cookie.is_expired(now) {
            return Err(AppError::new(
                ErrorCode::Unauthenticated,
                "Sync session expired",
            ));
        }
        Ok(cookie)
    }
}

fn default_path(path: &str) -> &str {
    path.rsplit_once('/').map_or(
        "/",
        |(parent, _)| if parent.is_empty() { "/" } else { parent },
    )
}

fn path_matches(cookie_path: &str, request_path: &str) -> bool {
    request_path == cookie_path
        || request_path
            .strip_prefix(cookie_path)
            .is_some_and(|suffix| cookie_path.ends_with('/') || suffix.starts_with('/'))
}

fn validate_attributes(header: &str, cookie: &Cookie<'_>) -> Result<(), AppError> {
    let mut seen = Vec::new();
    for attribute in header.split(';').skip(1) {
        let (name, value) = attribute
            .trim()
            .split_once('=')
            .map_or((attribute.trim(), None), |(name, value)| {
                (name, Some(value))
            });
        let name = name.trim().to_ascii_lowercase();
        if !matches!(
            name.as_str(),
            "domain" | "path" | "expires" | "max-age" | "secure" | "httponly" | "samesite"
        ) {
            continue;
        }
        if seen.contains(&name) {
            return Err(rejected_cookie());
        }
        let valid = match name.as_str() {
            "secure" | "httponly" => value.is_none(),
            "domain" | "path" => value.is_some_and(|v| !v.is_empty() && v.trim() == v),
            "expires" => value.is_some() && cookie.expires_datetime().is_some(),
            "max-age" => value.is_some_and(|v| {
                let digits = v.strip_prefix('-').unwrap_or(v);
                !digits.is_empty()
                    && digits.bytes().all(|b| b.is_ascii_digit())
                    && v.parse::<i64>().is_ok()
                    && cookie.max_age().is_some()
            }),
            "samesite" => value.is_some() && cookie.same_site().is_some(),
            _ => false,
        };
        if !valid {
            return Err(rejected_cookie());
        }
        seen.push(name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "deterministic cookie boundary fixtures")]
    use super::*;

    #[test]
    fn existing_server_cookie_and_security_boundaries() {
        let now = Millis::new(1_000).unwrap();
        let site = SiteOrigin::parse("https://notes.example.test").unwrap();
        let login = site.as_url().join("api/auth/login").unwrap();
        let cookie = SessionCookie::parse(
            &site,
            &login,
            "__Host-autonote_session=secret; Path=/; HttpOnly; SameSite=Lax; Max-Age=90; Secure",
            now,
        )
        .unwrap();
        assert_eq!(
            cookie.request_header(&login, now).unwrap().as_deref(),
            Some("__Host-autonote_session=secret")
        );
        assert!(
            cookie
                .request_header(&login, Millis::new(91_000).unwrap())
                .unwrap()
                .is_none()
        );
        assert!(!format!("{cookie:?}").contains("secret"));
        for url in [
            "http://notes.example.test/api",
            "https://notes.example.test:444/api",
            "https://other.example.test/api",
            "https://user:password@notes.example.test/api",
        ] {
            assert_eq!(
                cookie
                    .request_header(&Url::parse(url).unwrap(), now)
                    .unwrap_err()
                    .code(),
                ErrorCode::Forbidden
            );
        }
        for header in [
            "__Host-autonote_session=secret; Secure; Domain=notes.example.test; Path=/",
            "__Host-autonote_session=secret; Path=/",
            "autonote_session=secret; Domain=evil.test",
            "autonote_session=secret; Domain=ample.test",
            "autonote_session=secret; Max-Age=invalid",
            "autonote_session=secret; Max-Age=90; Max-Age=100",
            "autonote_session=secret; Max-Age =90; Max-Age=100",
            "autonote_session=secret; Max-Age=9223372036854775807",
            "autonote_session=secret; SameSite=invalid",
            "autonote_session=secret; HttpOnly=false",
            "autonote_session=secret; Expires=invalid",
            "autonote_session=secret; SameSite=None",
            "autonote_session=secret; Secure=false",
            "autonote_session=secret\r\nInjected: value",
        ] {
            assert_eq!(
                SessionCookie::parse(&site, &login, header, now)
                    .unwrap_err()
                    .code(),
                ErrorCode::InvalidResponse
            );
        }
        let scoped = SessionCookie::parse(&site, &login,
            "autonote_session=secret; Domain=example.test; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=90", now).unwrap();
        assert!(
            scoped
                .request_header(&site.as_url().join("api/auth/child").unwrap(), now)
                .unwrap()
                .is_some()
        );
        assert!(
            scoped
                .request_header(&site.as_url().join("api/authentication").unwrap(), now)
                .unwrap()
                .is_none()
        );
        let deleted =
            SessionCookie::parse(&site, &login, "autonote_session=; Max-Age=0", now).unwrap();
        assert!(deleted.is_expired(now));
        let expires = SessionCookie::parse(
            &site,
            &login,
            "autonote_session=secret; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
            now,
        )
        .unwrap();
        assert!(expires.is_expired(now));
        for origin in [
            "https://user:password@notes.example.test",
            "https://notes.example.test/api",
            "https://notes.example.test?token=secret",
            "file:///library",
            " https://notes.example.test",
            "http://notes.example.test",
            "http://192.168.1.10:7712",
        ] {
            assert_eq!(
                SiteOrigin::parse(origin).unwrap_err().code(),
                ErrorCode::BadRequest
            );
        }
        for origin in [
            "http://localhost:7712",
            "http://[::1]:7712",
            "https://notes.example.test",
        ] {
            assert!(SiteOrigin::parse(origin).is_ok(), "{origin}");
        }
        let local = SiteOrigin::parse("http://127.0.0.1:7713").unwrap();
        let legacy = SessionCookie::parse(
            &local,
            local.as_url(),
            "autonote_session=secret; Path=/; HttpOnly; SameSite=Lax; Max-Age=90",
            now,
        )
        .unwrap();
        assert!(
            legacy
                .request_header(local.as_url(), now)
                .unwrap()
                .is_some()
        );
    }
}
