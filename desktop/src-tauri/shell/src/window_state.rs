//! Only normal bounds and maximized state persist; never hidden/minimized.
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Versioned normal window bounds in physical pixels; DPI is the monitor scale factor.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowState {
    pub version: u8,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub dpi: f64,
    pub maximized: bool,
}
impl WindowState {
    /// Returns no saved bounds for missing, unreadable, invalid or unsupported state.
    pub fn load(path: &Path) -> Option<Self> {
        let state: Self = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        (state.version == 1
            && state.width > 0
            && state.height > 0
            && state.dpi.is_finite()
            && state.dpi > 0.0)
            .then_some(state)
    }
    /// Scales normal bounds and keeps the complete window inside the current work area.
    pub fn clamp(
        self,
        x: i32,
        y: i32,
        available_width: u32,
        available_height: u32,
        dpi: f64,
    ) -> Self {
        let scale = dpi / self.dpi;
        let width = ((f64::from(self.width) * scale) as u32)
            .max(960.min(available_width))
            .min(available_width);
        let height = ((f64::from(self.height) * scale) as u32)
            .max(640.min(available_height))
            .min(available_height);
        let dx = i32::try_from(available_width.saturating_sub(width)).unwrap_or(i32::MAX);
        let dy = i32::try_from(available_height.saturating_sub(height)).unwrap_or(i32::MAX);
        Self {
            x: self.x.clamp(x, x.saturating_add(dx)),
            y: self.y.clamp(y, y.saturating_add(dy)),
            width,
            height,
            dpi,
            ..self
        }
    }
    /// Atomically saves normal bounds without truncating the previous state.
    /// # Errors
    /// Returns serialization, sync or replacement failures.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        super::desktop_prefs::save(path, self)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removed_monitor_and_small_screen_stay_visible() {
        let state = WindowState {
            version: 1,
            x: -5000,
            y: 9000,
            width: 1280,
            height: 820,
            dpi: 1.0,
            maximized: true,
        };
        let clamped = state.clamp(0, 0, 800, 600, 1.5);
        assert_eq!(
            (clamped.x, clamped.y, clamped.width, clamped.height),
            (0, 0, 800, 600)
        );
    }
    #[test]
    fn scaling_preserves_normal_size_and_negative_monitor_positions() {
        let state = WindowState {
            version: 1,
            x: -1500,
            y: 20,
            width: 1000,
            height: 700,
            dpi: 1.0,
            maximized: false,
        };
        let clamped = state.clamp(-1920, 0, 1920, 1080, 1.25);
        assert_eq!((clamped.width, clamped.height), (1250, 875));
        assert_eq!(clamped.x, -1500);
        assert!(!clamped.maximized);
    }
}
