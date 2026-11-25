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

use std::{
    io::{self, Read, Write},
    net::TcpListener,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use crate::{
    engine::{Engine, EngineOptions},
    protocol::{encode_frame, Action, Endpoint, FrameDecoder, Message, SystemEffect},
};

const POLL: Duration = Duration::from_millis(50);
const GRACE: Duration = Duration::from_secs(2);
const INPUT_BYTES: usize = 64 * 1024 * 1024;
const OUTPUT_BYTES: usize = 128 * 1024 * 1024;

struct Credit {
    used: Arc<AtomicUsize>,
    size: usize,
}

impl Credit {
    fn reserve(used: &Arc<AtomicUsize>, size: usize, limit: usize) -> Option<Self> {
        used.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
            n.checked_add(size).filter(|total| *total <= limit)
        })
        .ok()?;
        Some(Self {
            used: Arc::clone(used),
            size,
        })
    }
}

impl Drop for Credit {
    fn drop(&mut self) {
        self.used.fetch_sub(self.size, Ordering::Relaxed);
    }
}

enum Event {
    Message(Endpoint, Message, Credit),
    Eof(Endpoint),
    Fault(Endpoint, ProtocolError),
    WriterFault(ProtocolError),
}

type Frame = (Vec<u8>, Credit);

fn read_pipe(
    mut pipe: impl Read,
    endpoint: Endpoint,
    tx: SyncSender<Event>,
    budget: Arc<AtomicUsize>,
) {
    let result = (|| {
        let mut decoder = FrameDecoder::new();
        let mut buffer = [0; 16 * 1024];
        loop {
            let count = match pipe.read(&mut buffer) {
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                other => other?,
            };
            if count == 0 {
                decoder.finish()?;
                let _ = tx.send(Event::Eof(endpoint));
                break;
            }
            for (size, msg) in decoder.push_sized(&buffer[..count])? {
                let credit = Credit::reserve(&budget, size, INPUT_BYTES)
                    .ok_or(ProtocolError::Capacity("LSP input backpressure"))?;
                if tx.send(Event::Message(endpoint, msg, credit)).is_err() {
                    return Ok(());
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = tx.send(Event::Fault(endpoint, error));
    }
}

fn write_pipe(mut pipe: impl Write, rx: Receiver<Frame>, tx: SyncSender<Event>) {
    for (frame, _credit) in rx {
        if let Err(error) = pipe.write_all(&frame).and_then(|()| pipe.flush()) {
            let _ = tx.send(Event::WriterFault(error.into()));
            break;
        }
    }
}

struct Transport {
    client: SyncSender<Frame>,
    child: SyncSender<Frame>,
    budget: Arc<AtomicUsize>,
    helpers: Vec<Child>,
}

impl Transport {
    fn write(&self, endpoint: Endpoint, msg: &Message) -> Result<(), ProtocolError> {
        let frame = encode_frame(msg)?;
        let credit = Credit::reserve(&self.budget, frame.len(), OUTPUT_BYTES)
            .ok_or(ProtocolError::Capacity("LSP output backpressure"))?;
        let tx = match endpoint {
            Endpoint::Client => &self.client,
            Endpoint::Tinymist => &self.child,
        };
        tx.try_send((frame, credit))
            .map_err(|_| ProtocolError::Capacity("LSP writer unavailable or backlogged"))
    }

    fn apply(&mut self, actions: Vec<Action>) -> Result<Option<i32>, ProtocolError> {
        for action in actions {
            match action {
                Action::Write { to, message } => self.write(to, &message)?,
                Action::System(effect) if self.helpers.len() < 32 => match spawn_effect(effect) {
                    Ok(child) => self.helpers.push(child),
                    Err(err) => {
                        eprintln!("typst-preview-proxy: could not launch preview helper: {err}")
                    }
                },
                Action::System(_) => eprintln!("typst-preview-proxy: preview helper limit reached"),
                Action::Stop { exit_code } => return Ok(Some(exit_code)),
            }
        }
        Ok(None)
    }
}

pub fn run(options: Options) -> Result<i32, ProtocolError> {
    let port = TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port();
    let mut child = Command::new(&options.tinymist)
        .args(&options.tinymist_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let child_in = child.stdin.take().expect("piped stdin");
    let child_out = child.stdout.take().expect("piped stdout");
    let (tx, rx) = mpsc::sync_channel(64);
    let (client, client_rx) = mpsc::sync_channel(64);
    let (child_tx, child_rx) = mpsc::sync_channel(64);
    let input = Arc::new(AtomicUsize::new(0));
    let client_write = thread::spawn({
        let tx = tx.clone();
        move || write_pipe(io::stdout().lock(), client_rx, tx)
    });
    let child_write = thread::spawn({
        let tx = tx.clone();
        move || write_pipe(child_in, child_rx, tx)
    });
    thread::spawn({
        let tx = tx.clone();
        let input = input.clone();
        move || read_pipe(io::stdin().lock(), Endpoint::Client, tx, input)
    });
    thread::spawn(move || read_pipe(child_out, Endpoint::Tinymist, tx, input));

    let mut transport = Transport {
        client,
        child: child_tx,
        budget: Arc::new(AtomicUsize::new(0)),
        helpers: Vec::new(),
    };
    let mut engine = Engine::new(EngineOptions {
        mode: options.mode,
        preview_port: port,
    });
    let clock = Instant::now();
    let outcome = (|| {
        let mut exited = None;
        loop {
            if exited.is_none() {
                exited = child
                    .try_wait()?
                    .map(|status| (status.code().unwrap_or(1), Instant::now()));
            }
            if let Some((code, at)) = exited {
                if at.elapsed() >= GRACE {
                    return Ok(code);
                }
            }
            transport
                .helpers
                .retain_mut(|c| matches!(c.try_wait(), Ok(None)));
            let now = clock.elapsed();
            if let Some(code) = transport.apply(engine.on_tick(now)?)? {
                return Ok(code);
            }
            let wait = engine
                .next_deadline()
                .map_or(POLL, |due| due.saturating_sub(now).min(POLL));
            match rx.recv_timeout(wait) {
                Ok(Event::Message(endpoint, msg, _credit)) => {
                    let now = clock.elapsed();
                    let out = match endpoint {
                        Endpoint::Client => engine.on_client(msg, now)?,
                        Endpoint::Tinymist => engine.on_tinymist(msg, now)?,
                    };
                    if let Some(code) = transport.apply(out)? {
                        return Ok(code);
                    }
                }
                Ok(Event::Eof(Endpoint::Client)) => return Ok(0),
                Ok(Event::Eof(Endpoint::Tinymist)) => {
                    let until = Instant::now() + POLL;
                    while Instant::now() < until {
                        if let Some(status) = child.try_wait()? {
                            return Ok(status.code().unwrap_or(1));
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    return Err(ProtocolError::Framing("Tinymist closed its output"));
                }
                Ok(Event::Fault(endpoint, error)) => {
                    if endpoint == Endpoint::Client {
                        let reply = match error {
                            ProtocolError::InvalidJson => Some((-32700, "Parse error")),
                            ProtocolError::InvalidEnvelope => Some((-32600, "Invalid Request")),
                            _ => None,
                        };
                        if let Some((code, message)) = reply {
                            transport.write(endpoint,&serde_json::json!({"jsonrpc":"2.0","id":null,"error":{"code":code,"message":message}}))?;
                        }
                    }
                    return Err(error);
                }
                Ok(Event::WriterFault(error)) => {
                    if let Some(status) = child.try_wait()? {
                        return Ok(status.code().unwrap_or(1));
                    }
                    return Err(error);
                }
                Err(RecvTimeoutError::Disconnected) => return Ok(0),
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
    })();

    // Drop queues before waiting so writers can drain independently.
    // Readers blocked on the editor's stdin cannot delay process exit.
    drop(rx);
    drop(transport);
    let until = Instant::now() + GRACE;
    let mut child_done = false;
    while Instant::now() < until {
        child_done = child.try_wait().ok().flatten().is_some();
        if child_done && client_write.is_finished() && child_write.is_finished() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    if !child_done {
        let _ = child.kill();
        let _ = child.wait();
    }
    // GUI helpers are independent of the preview session.
    outcome
}

fn spawn_effect(effect: SystemEffect) -> io::Result<Child> {
    let mut cmd = match effect {
        SystemEffect::OpenBrowser { url } => {
            #[cfg(target_os = "macos")]
            let mut cmd = Command::new("/usr/bin/open");
            #[cfg(windows)]
            let mut cmd = {
                let mut cmd = Command::new("rundll32.exe");
                cmd.arg("url.dll,FileProtocolHandler");
                cmd
            };
            #[cfg(not(any(windows, target_os = "macos")))]
            let mut cmd = Command::new("xdg-open");
            cmd.arg(url.as_str());
            cmd
        }
        SystemEffect::JumpSource { path, line, column } => {
            let mut location = path.into_os_string();
            location.push(format!(":{line}:{column}"));
            let candidates: Vec<_> = std::env::var_os("ZED_CLI_PATH")
                .into_iter()
                .chain(
                    [
                        "/usr/local/bin/zed",
                        "/Applications/Zed.app/Contents/MacOS/cli",
                        "zed",
                        "zeditor",
                    ]
                    .into_iter()
                    .map(OsString::from),
                )
                .collect();
            let mut last = None;
            for candidate in candidates {
                match Command::new(candidate)
                    .arg("--")
                    .arg(&location)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                {
                    Ok(child) => return Ok(child),
                    Err(err) => last = Some(err),
                }
            }
            return Err(last.unwrap_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "Zed CLI unavailable")
            }));
        }
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

pub fn execute_effect(effect: SystemEffect) -> Result<(), ProtocolError> {
    let mut child = spawn_effect(effect)?;
    let status = child.wait()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("preview helper exited unsuccessfully").into())
    }
}
