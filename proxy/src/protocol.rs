use serde_json::Value;
use std::{fmt, io, path::PathBuf};
use url::Url;

const MAX_HEADER: usize = 8 * 1024;
const MAX_BODY: usize = 64 * 1024 * 1024;

pub type Message = Value;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Endpoint {
    Client,
    Tinymist,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    Typst,
    Markdown,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum RpcId {
    Int(i64),
    UInt(u64),
    Str(String),
}

#[derive(Debug)]
pub enum ProtocolError {
    Framing(&'static str),
    InvalidJson,
    InvalidEnvelope,
    InvalidPosition,
    Capacity(&'static str),
    Arguments(&'static str),
    Io(io::Error),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Framing(message) | Self::Capacity(message) | Self::Arguments(message) => {
                f.write_str(message)
            }
            Self::InvalidJson => f.write_str("invalid JSON-RPC body"),
            Self::InvalidEnvelope => f.write_str("invalid JSON-RPC envelope"),
            Self::InvalidPosition => f.write_str("invalid LSP position"),
            Self::Io(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ProtocolError {}

impl From<io::Error> for ProtocolError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub enum SystemEffect {
    OpenBrowser {
        url: Url,
    },
    JumpSource {
        path: PathBuf,
        line: u32,
        column: u32,
    },
}

pub enum Action {
    Write { to: Endpoint, message: Message },
    System(SystemEffect),
    Stop { exit_code: i32 },
}

pub fn rpc_id(value: &Value) -> Result<RpcId, ProtocolError> {
    if let Some(id) = value.as_i64() {
        Ok(RpcId::Int(id))
    } else if let Some(id) = value.as_u64() {
        Ok(RpcId::UInt(id))
    } else if let Some(id) = value.as_str() {
        Ok(RpcId::Str(id.to_owned()))
    } else {
        Err(ProtocolError::InvalidEnvelope)
    }
}

pub fn id_value(id: &RpcId) -> Value {
    match id {
        RpcId::Int(id) => Value::from(*id),
        RpcId::UInt(id) => Value::from(*id),
        RpcId::Str(id) => Value::from(id.as_str()),
    }
}

pub fn encode_frame(message: &Message) -> Result<Vec<u8>, ProtocolError> {
    let body = serde_json::to_vec(message).map_err(|_| ProtocolError::InvalidJson)?;
    if body.len() > MAX_BODY {
        return Err(ProtocolError::Capacity("LSP output body exceeds 64 MiB"));
    }
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut frame = Vec::with_capacity(header.len() + body.len());
    frame.extend_from_slice(header.as_bytes());
    frame.extend(body);
    Ok(frame)
}

#[derive(Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
    body_len: Option<usize>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    // The caller must close the transport on any decode error.
    pub fn push(&mut self, mut bytes: &[u8]) -> Result<Vec<Message>, ProtocolError> {
        let mut messages = Vec::new();
        while !bytes.is_empty() {
            if let Some(len) = self.body_len {
                let count = (len - self.buffer.len()).min(bytes.len());
                self.buffer.extend_from_slice(&bytes[..count]);
                bytes = &bytes[count..];
                if self.buffer.len() == len {
                    let body = std::mem::take(&mut self.buffer);
                    self.body_len = None;
                    let message =
                        serde_json::from_slice(&body).map_err(|_| ProtocolError::InvalidJson)?;
                    validate_envelope(&message)?;
                    messages.push(message);
                }
            } else {
                self.buffer.push(bytes[0]);
                bytes = &bytes[1..];
                if self.buffer.ends_with(b"\r\n\r\n") {
                    self.body_len = Some(content_length(&self.buffer[..self.buffer.len() - 4])?);
                    self.buffer.clear();
                } else if self.buffer.len() == MAX_HEADER {
                    return Err(ProtocolError::Framing("LSP header exceeds 8 KiB"));
                }
            }
        }
        Ok(messages)
    }

    pub fn finish(&self) -> Result<(), ProtocolError> {
        if self.buffer.is_empty() && self.body_len.is_none() {
            Ok(())
        } else {
            Err(ProtocolError::Framing("partial LSP frame at EOF"))
        }
    }
}

fn content_length(header: &[u8]) -> Result<usize, ProtocolError> {
    let header = std::str::from_utf8(header)
        .map_err(|_| ProtocolError::Framing("invalid LSP header encoding"))?;
    let mut length = None;
    for line in header.split("\r\n") {
        let (name, value) = line
            .split_once(':')
            .ok_or(ProtocolError::Framing("invalid LSP header field"))?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
            || !value
                .bytes()
                .all(|b| b == b'\t' || (b' '..=b'~').contains(&b))
        {
            return Err(ProtocolError::Framing("invalid LSP header field"));
        }
        if name.eq_ignore_ascii_case("Content-Length") {
            if length.is_some() {
                return Err(ProtocolError::Framing("duplicate Content-Length"));
            }
            let value = value.trim_matches([' ', '\t']);
            if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(ProtocolError::Framing("invalid Content-Length"));
            }
            let len: usize = value
                .parse()
                .map_err(|_| ProtocolError::Framing("invalid Content-Length"))?;
            if len > MAX_BODY {
                return Err(ProtocolError::Capacity("LSP input body exceeds 64 MiB"));
            }
            if len == 0 {
                return Err(ProtocolError::InvalidJson);
            }
            length = Some(len);
        }
    }
    length.ok_or(ProtocolError::Framing("missing Content-Length"))
}

fn validate_envelope(message: &Message) -> Result<(), ProtocolError> {
    let object = message.as_object().ok_or(ProtocolError::InvalidEnvelope)?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(ProtocolError::InvalidEnvelope);
    }

    let result = object.contains_key("result");
    let error = object.contains_key("error");
    let id = object.get("id");
    if let Some(method) = object.get("method") {
        if !method.is_string() || result || error {
            return Err(ProtocolError::InvalidEnvelope);
        }
        if let Some(id) = id {
            rpc_id(id)?;
        }
    } else {
        let id = id.ok_or(ProtocolError::InvalidEnvelope)?;
        if result == error {
            return Err(ProtocolError::InvalidEnvelope);
        }
        if !(error && id.is_null()) {
            rpc_id(id)?;
        }
    }
    Ok(())
}
