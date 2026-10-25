## Downloads / 下载

| Asset | Platform |
|---|---|
| AutoNote-windows-setup.exe | Windows x64 installer / 安装版 |
| AutoNote-windows-portable.zip | Windows x64 portable / 便携版 |
| AutoNote-macos-arm64.dmg | macOS 11+ Apple Silicon |
| AutoNote-linux-x64.AppImage | Linux x64 AppImage |
| AutoNote-linux-x64.deb | Ubuntu 22.04+ / Debian-compatible x64 DEB |

Windows requires WebView2. Windows data remains beside the executable in data. macOS data: ~/Library/Application Support/com.autonote.desktop. Linux data: absolute $XDG_DATA_HOME/com.autonote.desktop, otherwise ~/.local/share/com.autonote.desktop.

macOS is ad-hoc signed, **not Developer ID signed or notarized**; Gatekeeper may require explicit approval in Privacy & Security. Linux is built on Ubuntu 22.04 and requires WebKitGTK 4.1, GTK 3, AppIndicator and an unlocked Secret Service (for example GNOME Keyring) for saved credentials. AppImage may require FUSE 2 or --appimage-extract-and-run.

macOS 为临时签名，未经 Developer ID 签名及 Apple 公证；可能需要在隐私与安全性中明确允许。Linux 基于 Ubuntu 22.04 构建，保存凭据需已解锁的 Secret Service（如 GNOME Keyring）；并非任意发行版通用。

Native compilation, complete automated checks, secure-store restart/tamper checks, package hashes and macOS/Linux packaged startup/window/database/screenshot smoke are release gates. These do not replace human installation, upgrade, tray, shortcuts or complete UI lifecycle acceptance. Windows interactive acceptance remains separate.

原生编译、完整自动检查、安全存储跨进程及篡改检查、包哈希和 macOS/Linux 打包应用启动冒烟为发布门禁，不代表已完成人工安装、升级、托盘、快捷键或完整界面生命周期验收。
