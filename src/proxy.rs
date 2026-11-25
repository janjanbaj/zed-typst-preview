use zed_extension_api::{self as zed, LanguageServerId, Worktree};

pub fn command(
    server_id: &LanguageServerId,
    worktree: &Worktree,
    javascript_proxy_path: String,
    tinymist_path: String,
) -> zed::Result<zed::Command> {
    let settings = zed::settings::LspSettings::for_worktree(server_id.as_ref(), worktree).ok();
    let native = settings.as_ref().and_then(|settings| {
        settings
            .settings
            .as_ref()?
            .pointer("/previewProxy/nativePath")
    });
    let initial = settings.as_ref().and_then(|settings| {
        settings
            .initialization_options
            .as_ref()?
            .pointer("/previewProxy/nativePath")
    });
    if native.zip(initial).is_some_and(|(a, b)| a != b) {
        return Err(
            "previewProxy.nativePath differs in settings and initialization_options".into(),
        );
    }
    let (command, mut args) = if let Some(path) = native.or(initial) {
        let path = path
            .as_str()
            .filter(|p| is_absolute(p))
            .ok_or("previewProxy.nativePath must be an absolute executable path")?;
        (path.to_owned(), vec!["--tinymist".into(), tinymist_path])
    } else {
        (
            zed::node_binary_path()?,
            vec![javascript_proxy_path, tinymist_path],
        )
    };
    if server_id.as_ref() == "markdown-typst-preview" {
        args.push("--markdown".into());
    }
    Ok(zed::Command {
        command,
        args,
        env: worktree.shell_env(),
    })
}

fn is_absolute(path: &str) -> bool {
    if path.contains('\0') {
        return false;
    }
    if zed::current_platform().0 == zed::Os::Windows {
        let bytes = path.as_bytes();
        path.starts_with(r"\\")
            || matches!(bytes,[drive,b':',b'/'|b'\\',..] if drive.is_ascii_alphabetic())
    } else {
        path.starts_with('/')
    }
}
