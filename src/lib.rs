use zed_extension_api::{self as zed, LanguageServerId, Result, Worktree};

mod tinymist;
use tinymist::TinymistBinary;

struct TypstPreviewExtension {
    tinymist: TinymistBinary,
}

impl TypstPreviewExtension {
    fn new() -> Self {
        Self {
            tinymist: TinymistBinary::new(),
        }
    }
}

fn default_tinymist_settings() -> serde_json::Value {
    serde_json::json!({
        "exportPdf": "onSave",
        "formatterMode": "typstyle",
        "systemFonts": true,
    })
}

impl zed::Extension for TypstPreviewExtension {
    fn new() -> Self {
        Self::new()
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<zed::Command> {
        let (proxy_path, tinymist_bin) = self.tinymist.ensure(language_server_id, worktree)?;
        let node_path = zed::node_binary_path()?;

        let mut args = vec![proxy_path, tinymist_bin];
        if language_server_id.as_ref() == "markdown-typst-preview" {
            args.push("--markdown".into());
        }

        Ok(zed::Command {
            command: node_path,
            args,
            env: worktree.shell_env(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<serde_json::Value>> {
        let opts = zed::settings::LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|lsp| lsp.initialization_options.or(lsp.settings))
            .unwrap_or_else(default_tinymist_settings);

        Ok(Some(opts))
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<serde_json::Value>> {
        let config = zed::settings::LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|lsp| lsp.settings.or(lsp.initialization_options))
            .unwrap_or_else(default_tinymist_settings);

        Ok(Some(config))
    }
}

zed::register_extension!(TypstPreviewExtension);
