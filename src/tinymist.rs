use zed_extension_api::{self as zed, DownloadedFileType, LanguageServerId, Result, Worktree};

const TINYMIST_VERSION: &str = "0.14.10";

pub struct TinymistBinary;

impl TinymistBinary {
    pub fn new() -> Self {
        Self
    }

    /// Ensures proxy.mjs is written and returns (proxy_path, tinymist_bin_path).
    pub fn ensure(
        &self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<(String, String)> {
        let work_dir = std::env::current_dir()
            .map_err(|e| format!("failed to get current dir: {e}"))?
            .to_string_lossy()
            .to_string();

        let tinymist_dir = format!("{work_dir}/tinymist");
        std::fs::create_dir_all(&tinymist_dir)
            .map_err(|e| format!("failed to create dir {tinymist_dir}: {e}"))?;

        // 1. ALWAYS write proxy.mjs to ensure latest proxy is present
        let proxy_path = format!("{tinymist_dir}/proxy.mjs");
        std::fs::write(&proxy_path, include_str!("../proxy.mjs"))
            .map_err(|e| format!("failed to write proxy.mjs: {e}"))?;

        // 2. Check user settings binary path
        let lsp_settings = zed::settings::LspSettings::for_worktree(language_server_id.as_ref(), worktree).ok();
        if let Some(user_bin) = lsp_settings
            .as_ref()
            .and_then(|s| s.binary.as_ref())
            .and_then(|b| b.path.clone())
        {
            if std::fs::metadata(&user_bin).is_ok() {
                return Ok((proxy_path, user_bin));
            }
        }

        // 3. Check PATH via worktree.which("tinymist")
        if let Some(which_path) = worktree.which("tinymist") {
            return Ok((proxy_path, which_path));
        }

        // 4. Check local downloaded binary in work directory
        let asset_name = Self::get_asset_name()?;
        let local_bin = format!("{tinymist_dir}/{asset_name}");

        if std::fs::metadata(&local_bin).is_ok() {
            return Ok((proxy_path, local_bin));
        }

        // 5. Check if cached in typst-preview work dir
        let legacy_bin = format!("{work_dir}/../typst-preview/tinymist/{asset_name}");
        if std::fs::metadata(&legacy_bin).is_ok() {
            let _ = std::fs::copy(&legacy_bin, &local_bin);
            if std::fs::metadata(&local_bin).is_ok() {
                return Ok((proxy_path, local_bin));
            }
        }

        // 6. Download binary if not present
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::Downloading,
        );

        let url = format!(
            "https://github.com/Myriad-Dreamin/tinymist/releases/download/v{TINYMIST_VERSION}/{asset_name}"
        );
        let rel_path = format!("tinymist/{asset_name}");

        zed::download_file(&url, &rel_path, DownloadedFileType::Uncompressed)
            .map_err(|e| format!("Failed to download tinymist from {url}: {e}"))?;

        let (os, _) = zed::current_platform();
        if os != zed::Os::Windows {
            zed::make_file_executable(&local_bin)
                .map_err(|e| format!("Failed to make {local_bin} executable: {e}"))?;
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::None,
        );

        Ok((proxy_path, local_bin))
    }

    fn get_asset_name() -> Result<&'static str> {
        let (os, arch) = zed::current_platform();
        match (os, arch) {
            (zed::Os::Mac, zed::Architecture::Aarch64) => Ok("tinymist-darwin-arm64"),
            (zed::Os::Mac, zed::Architecture::X8664) => Ok("tinymist-darwin-x64"),
            (zed::Os::Linux, zed::Architecture::Aarch64) => Ok("tinymist-linux-arm64"),
            (zed::Os::Linux, zed::Architecture::X8664) => Ok("tinymist-linux-x64"),
            (zed::Os::Windows, zed::Architecture::Aarch64) => Ok("tinymist-win32-arm64.exe"),
            (zed::Os::Windows, zed::Architecture::X8664) => Ok("tinymist-win32-x64.exe"),
            _ => Err(format!("Unsupported platform: {os:?} {arch:?}")),
        }
    }
}
