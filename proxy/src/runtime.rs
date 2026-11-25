use std::{ffi::OsString, path::PathBuf};

use crate::protocol::{Mode, ProtocolError};

#[derive(Debug)]
pub struct Options {
    pub tinymist: PathBuf,
    pub tinymist_args: Vec<OsString>,
    pub mode: Mode,
}

#[derive(Debug)]
pub enum Cli {
    Run(Options),
    Help,
    Version,
}

pub fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<Cli, ProtocolError> {
    let mut args = args.into_iter().peekable();
    let mut tinymist = None;
    let mut mode = Mode::Typst;
    let mut tinymist_args = Vec::new();

    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--") => {
                tinymist_args.extend(args);
                break;
            }
            Some("--help") | Some("--version")
                if tinymist.is_none() && mode == Mode::Typst && args.peek().is_none() =>
            {
                return Ok(if arg == "--help" {
                    Cli::Help
                } else {
                    Cli::Version
                });
            }
            Some("--tinymist") if tinymist.is_none() => {
                let path = args
                    .next()
                    .filter(|path| !path.is_empty() && !path.as_encoded_bytes().starts_with(b"--"))
                    .ok_or(ProtocolError::Arguments(
                        "--tinymist requires one executable path",
                    ))?;
                tinymist = Some(PathBuf::from(path));
            }
            Some("--markdown") if mode == Mode::Typst => mode = Mode::Markdown,
            _ => {
                return Err(ProtocolError::Arguments(
                    "unknown, duplicate, or misplaced proxy option",
                ))
            }
        }
    }

    let tinymist = tinymist.ok_or(ProtocolError::Arguments("--tinymist is required"))?;
    if !tinymist_args.iter().any(|arg| arg == "lsp") {
        tinymist_args.insert(0, "lsp".into());
    }
    Ok(Cli::Run(Options {
        tinymist,
        tinymist_args,
        mode,
    }))
}
