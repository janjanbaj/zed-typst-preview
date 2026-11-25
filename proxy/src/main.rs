use std::process::ExitCode;

use typst_preview_proxy::runtime::{parse_args, run, Cli};

fn main() -> ExitCode {
    match parse_args(std::env::args_os().skip(1)) {
        Ok(Cli::Help) => {
            println!("Usage: typst-preview-proxy --tinymist <executable> [--markdown] [-- <tinymist arguments>...]\n       typst-preview-proxy --help | --version");
            ExitCode::SUCCESS
        }
        Ok(Cli::Version) => {
            println!("typst-preview-proxy {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(Cli::Run(options)) => match run(options) {
            Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
            Err(error) => {
                eprintln!("typst-preview-proxy: {error}");
                ExitCode::FAILURE
            }
        },
        Err(error) => {
            eprintln!("typst-preview-proxy: {error}");
            ExitCode::from(2)
        }
    }
}
