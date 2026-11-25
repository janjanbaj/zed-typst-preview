use std::{ffi::OsString, path::Path, process::Command};

use serde_json::json;
use typst_preview_proxy::{
    protocol::{encode_frame, id_value, rpc_id, FrameDecoder, Mode, ProtocolError, RpcId},
    runtime::{parse_args, Cli},
};

#[test]
fn framing_handles_every_split_and_counts_utf8_bytes() {
    let message = json!({"jsonrpc":"2.0", "id":0, "result":"😀α"});
    let frame = encode_frame(&message).unwrap();
    let header = format!(
        "Content-Length: {}\r\n\r\n",
        serde_json::to_string(&message).unwrap().len()
    );
    assert!(frame.starts_with(header.as_bytes()));
    for split in 0..=frame.len() {
        let mut decoder = FrameDecoder::new();
        let mut output = decoder.push(&frame[..split]).unwrap();
        output.extend(decoder.push(&frame[split..]).unwrap());
        decoder.finish().unwrap();
        assert_eq!(
            output.as_slice(),
            std::slice::from_ref(&message),
            "split at {split}"
        );
    }
}

#[test]
fn reader_accepts_multiple_frames_and_case_insensitive_headers() {
    let notification = json!({"jsonrpc":"2.0", "method":"initialized", "extra":42});
    let response =
        json!({"jsonrpc":"2.0", "id":null, "error":{"code":-32700,"message":"parse error"}});
    let body = serde_json::to_string(&notification).unwrap();
    let mut frames = format!(
        "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    ).into_bytes();
    frames.extend(encode_frame(&response).unwrap());
    assert_eq!(
        FrameDecoder::new().push(&frames).unwrap(),
        [notification, response]
    );
}

#[test]
fn reader_rejects_bad_lengths_and_incomplete_frames() {
    for header in [
        "Other: 1\r\n\r\n",
        "Content-Length: 2\r\ncontent-length: 3\r\n\r\n",
        "Content-Length: -1\r\n\r\n",
        "Content-Length: +1\r\n\r\n",
        "Content-Length: 111111111111111111111111111111111\r\n\r\n",
        "Content-Length: 1\nOther: 1\r\n\r\n",
    ] {
        assert!(matches!(
            FrameDecoder::new().push(header.as_bytes()),
            Err(ProtocolError::Framing(_))
        ));
    }
    assert!(matches!(
        FrameDecoder::new().push(&vec![b'a'; 8193]),
        Err(ProtocolError::Framing(_))
    ));
    assert!(matches!(
        FrameDecoder::new().push(b"Content-Length: 67108865\r\n\r\n"),
        Err(ProtocolError::Capacity(_))
    ));
    for partial in [
        b"Content-Length:".as_slice(),
        b"Content-Length: 2\r\n\r\n",
        b"Content-Length: 2\r\n\r\n{",
    ] {
        let mut decoder = FrameDecoder::new();
        assert!(decoder.push(partial).unwrap().is_empty());
        assert!(decoder.finish().is_err());
    }
}

#[test]
fn malformed_json_and_envelopes_have_distinct_errors() {
    for bytes in [
        b"Content-Length: 1\r\n\r\n\xff".as_slice(),
        b"Content-Length: 1\r\n\r\n{",
        b"Content-Length: 0\r\n\r\n",
    ] {
        assert!(matches!(
            FrameDecoder::new().push(bytes),
            Err(ProtocolError::InvalidJson)
        ));
    }
    for value in [
        json!([]),
        json!({"jsonrpc":"2.0","id":0}),
        json!({"jsonrpc":"2.0","id":null,"method":"test"}),
        json!({"jsonrpc":"2.0","id":0,"method":"test","result":null}),
    ] {
        assert!(matches!(
            FrameDecoder::new().push(&encode_frame(&value).unwrap()),
            Err(ProtocolError::InvalidEnvelope)
        ));
    }
}

#[test]
fn ids_preserve_numbers_and_strings_without_float_conversion() {
    for (value, expected) in [
        (json!(0), RpcId::Int(0)),
        (json!(-1), RpcId::Int(-1)),
        (json!("0"), RpcId::Str("0".into())),
        (json!(u64::MAX), RpcId::UInt(u64::MAX)),
    ] {
        assert_eq!(rpc_id(&value).unwrap(), expected);
        assert_eq!(id_value(&expected), value);
    }
    assert!(rpc_id(&json!(1.0)).is_err());
    assert!(rpc_id(&json!(null)).is_err());
}

fn parse(args: &[&str]) -> Result<Cli, ProtocolError> {
    parse_args(args.iter().map(OsString::from))
}

#[test]
fn cli_forwards_literal_arguments_after_separator() {
    let Cli::Run(options) = parse(&[
        "--tinymist",
        "path with spaces/tinymist",
        "--markdown",
        "--",
        "--version",
        "--markdown",
        "two words",
    ])
    .unwrap() else {
        panic!("expected run options")
    };
    assert_eq!(options.tinymist, Path::new("path with spaces/tinymist"));
    assert_eq!(options.mode, Mode::Markdown);
    assert_eq!(
        options.tinymist_args,
        ["lsp", "--version", "--markdown", "two words"]
    );
    let Cli::Run(options) = parse(&["--tinymist", "tinymist", "--", "lsp"]).unwrap() else {
        panic!("expected run options")
    };
    assert_eq!(options.tinymist_args, ["lsp"]);
    assert_eq!(options.mode, Mode::Typst);
}

#[test]
fn cli_validates_proxy_flags() {
    for args in [
        &[][..],
        &["--tinymist"],
        &["--tinymist", "--markdown"],
        &["--tinymist", "a", "--tinymist", "b"],
        &["--tinymist", "a", "--markdown", "--markdown"],
        &["--unrecognized"],
    ] {
        assert!(matches!(parse(args), Err(ProtocolError::Arguments(_))));
    }
}

#[test]
fn binary_reports_help_version_and_exit_status() {
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_typst-preview-proxy"))
            .args(args)
            .output()
            .unwrap()
    };
    assert!(run(&["--help"]).stdout.starts_with(b"Usage:"));
    assert!(run(&["--version"])
        .stdout
        .starts_with(b"typst-preview-proxy "));
    let invalid = run(&[]);
    assert_eq!(invalid.status.code(), Some(2));
    assert!(invalid.stdout.is_empty());

    let unfinished = run(&["--tinymist", "unused"]);
    assert_eq!(unfinished.status.code(), Some(1));
    assert!(unfinished.stdout.is_empty());
}
