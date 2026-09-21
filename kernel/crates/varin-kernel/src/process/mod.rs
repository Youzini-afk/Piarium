//! One native process service for PTYs and protocol pipes. Per-process guardians
//! are private instances of this executable, not Host/Pi processes or authorities.
//! The kernel owns grants, durable identities, admission and raw byte cursors.
pub(crate) mod platform;
pub(crate) mod worker;
use crate::{
    error::KernelError,
    protocol::{hash_json, read_frame, write_frame},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    io,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        mpsc::{self, SyncSender},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const BUFFER_BYTES: usize = 1024 * 1024;
pub(crate) const CHUNK_BYTES: usize = 64 * 1024;
struct Chunk {
    offset: u64,
    channel: String,
    bytes: Vec<u8>,
}
#[derive(Default)]
struct Buffer {
    chunks: VecDeque<Chunk>,
    base: u64,
    end: u64,
    closed: bool,
    discard: bool,
    pid: Option<u32>,
    receipt: Option<Value>,
    control_error: Option<String>,
    input_sequence: i64,
    queued_sequence: i64,
    input_hash: String,
    input_error: Option<String>,
}
struct Shared {
    buffer: Mutex<Buffer>,
    space: Condvar,
}
impl Shared {
    fn new() -> Self {
        Self {
            buffer: Mutex::new(Buffer {
                input_sequence: -1,
                queued_sequence: -1,
                ..Buffer::default()
            }),
            space: Condvar::new(),
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Buffer> {
        self.buffer
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}
struct LiveProcess {
    guardian: Child,
    containment: platform::Containment,
    input: Option<SyncSender<Value>>,
    shared: Arc<Shared>,
    guardian_exited: bool,
    requested_stop: bool,
}
#[derive(Default)]
pub(crate) struct ProcessManager {
    live: HashMap<String, LiveProcess>,
}
fn failure(message: impl Into<String>) -> KernelError {
    KernelError::Operation(message.into())
}
pub(crate) fn receipt_path(root: &Path, process_id: &str) -> PathBuf {
    root.join("process-receipts").join(format!(
        "{}.json",
        hex::encode(Sha256::digest(process_id.as_bytes()))
    ))
}
pub(crate) fn job_name(root: &Path, process_id: &str) -> String {
    format!(
        "Local\\Varin-{}",
        hex::encode(Sha256::digest(
            format!("{}\0{process_id}", root.display()).as_bytes()
        ))
    )
}
pub(crate) fn read_receipt(
    root: &Path,
    process_id: &str,
    epoch: &str,
) -> Result<Option<Value>, KernelError> {
    let raw = match std::fs::read(receipt_path(root, process_id)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let value: Value = serde_json::from_slice(&raw)?;
    if value["processId"].as_str() != Some(process_id)
        || value["kernelEpoch"].as_str() != Some(epoch)
        || value["treeConfirmed"].as_bool() != Some(true)
        || !matches!(value["status"].as_str(), Some("exited" | "failed"))
    {
        return Err(failure("process exit receipt identity is invalid"));
    }
    Ok(Some(value))
}
impl ProcessManager {
    pub(crate) fn spawn(&mut self, id: &str, config: Value) -> Result<(), KernelError> {
        if self.live.contains_key(id) {
            return Err(failure("process identity is already live"));
        }
        let mut command = Command::new(std::env::current_exe()?);
        command
            .arg("--process-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(
                if std::env::var("VARIN_KERNEL_DEBUG").as_deref() == Ok("1") {
                    Stdio::inherit()
                } else {
                    Stdio::null()
                },
            );
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut guardian = command.spawn()?;
        let containment = match platform::Containment::admit(
            config["jobName"].as_str().unwrap_or_default(),
            &guardian,
        ) {
            Ok(containment) => containment,
            Err(error) => {
                let _ = guardian.kill();
                let _ = guardian.wait();
                return Err(error.into());
            }
        };
        let mut stdin = guardian
            .stdin
            .take()
            .ok_or_else(|| failure("guardian stdin missing"))?;
        let mut stdout = guardian
            .stdout
            .take()
            .ok_or_else(|| failure("guardian stdout missing"))?;
        let shared = Arc::new(Shared::new());
        let (input, input_rx) = mpsc::sync_channel::<Value>(4);
        let writer_shared = shared.clone();
        thread::spawn(move || {
            // This is the first message; the guardian cannot spawn before it.
            let result = write_frame(&mut stdin, &config).and_then(|_| {
                for event in input_rx {
                    write_frame(&mut stdin, &event)?;
                }
                Ok(())
            });
            if result.is_err() {
                writer_shared.lock().control_error =
                    Some("native process control pipe closed".into());
            }
            // Dropping stdin triggers the guardian's EOF cleanup, even on Host loss.
        });
        let reader_shared = shared.clone();
        thread::spawn(move || {
            let result = (|| -> io::Result<()> {
                while let Some(frame) = read_frame(&mut stdout)? {
                    let value: Value = serde_json::from_slice(&frame)?;
                    let mut buffer = reader_shared.lock();
                    match value["type"].as_str() {
                        Some("started") => buffer.pid = value["pid"].as_u64().map(|pid| pid as u32),
                        Some("receipt") => buffer.receipt = Some(value["value"].clone()),
                        Some("input") => {
                            buffer.input_sequence = value["sequence"].as_i64().unwrap_or(-1);
                            buffer.input_error = value["error"].as_str().map(str::to_string);
                        }
                        Some("output") => {
                            let bytes = BASE64
                                .decode(value["bytesBase64"].as_str().unwrap_or_default())
                                .map_err(io::Error::other)?;
                            if bytes.len() > CHUNK_BYTES {
                                return Err(io::Error::other(
                                    "native process frame exceeded chunk bound",
                                ));
                            }
                            let channel = value["channel"]
                                .as_str()
                                .filter(|v| matches!(*v, "stdout" | "stderr"))
                                .ok_or_else(|| io::Error::other("invalid native process channel"))?
                                .to_string();
                            while !buffer.discard
                                && (buffer.end - buffer.base) as usize + bytes.len() > BUFFER_BYTES
                            {
                                buffer = reader_shared
                                    .space
                                    .wait(buffer)
                                    .unwrap_or_else(|poison| poison.into_inner());
                            }
                            if !buffer.discard {
                                let offset = buffer.end;
                                buffer.end += bytes.len() as u64;
                                buffer.chunks.push_back(Chunk {
                                    offset,
                                    channel,
                                    bytes,
                                });
                            }
                        }
                        Some("output-error" | "control-error") => {
                            buffer.control_error =
                                Some("native process stream or PTY control failed".into())
                        }
                        _ => return Err(io::Error::other("invalid native process event")),
                    }
                }
                Ok(())
            })();
            let mut buffer = reader_shared.lock();
            if result.is_err() {
                buffer.control_error =
                    Some("native process stream ended without a complete frame".into());
            }
            buffer.closed = true;
        });
        self.live.insert(
            id.into(),
            LiveProcess {
                guardian,
                containment,
                input: Some(input),
                shared,
                guardian_exited: false,
                requested_stop: false,
            },
        );
        Ok(())
    }
    pub(crate) fn observation(&mut self, id: &str) -> Result<Option<Value>, KernelError> {
        let Some(live) = self.live.get_mut(id) else {
            return Ok(None);
        };
        if !live.guardian_exited && live.guardian.try_wait()?.is_some() {
            live.guardian_exited = true;
        }
        let buffer = live.shared.lock();
        let mut status = if buffer.pid.is_some() {
            "running"
        } else {
            "starting"
        };
        let mut reason = buffer.control_error.clone();
        let mut exit_code = Value::Null;
        let mut signal = Value::Null;
        if live.guardian_exited {
            #[cfg(windows)]
            if !live.containment.empty()? {
                live.containment.terminate(&live.guardian, true)?;
            }
            if buffer.closed && live.containment.empty()? {
                let receipt = buffer
                    .receipt
                    .as_ref()
                    .filter(|v| v["treeConfirmed"].as_bool() == Some(true));
                if let Some(receipt) = receipt {
                    status = receipt["status"].as_str().unwrap_or("unknown");
                    exit_code = receipt["exitCode"].clone();
                    signal = receipt["signal"].clone();
                    reason = receipt["reason"].as_str().map(str::to_string).or(reason);
                } else {
                    #[cfg(windows)]
                    {
                        status = "exited";
                        reason = Some("native Job exited; target exit status unavailable".into());
                    }
                    #[cfg(unix)]
                    {
                        status = "unknown";
                        reason = Some(
                            "guardian exited without proof that the process tree stopped".into(),
                        );
                    }
                }
            }
        }
        Ok(Some(
            json!({"status":status, "pid":buffer.pid, "exitCode":exit_code, "signal":signal,
            "reason":reason, "writerActive":!matches!(status,"exited"|"failed"), "outputAvailable":true}),
        ))
    }
    pub(crate) fn read(
        &mut self,
        id: &str,
        cursor: u64,
        limit: usize,
    ) -> Result<Value, KernelError> {
        let live = self
            .live
            .get_mut(id)
            .ok_or_else(|| failure("process stream belongs to an unavailable kernel epoch"))?;
        let mut buffer = live.shared.lock();
        if cursor < buffer.base || cursor > buffer.end {
            return Err(failure("process output cursor is outside retained bytes"));
        }
        while buffer
            .chunks
            .front()
            .is_some_and(|c| c.offset + c.bytes.len() as u64 <= cursor)
        {
            buffer.chunks.pop_front();
        }
        if let Some(front) = buffer.chunks.front_mut() {
            if cursor > front.offset {
                front.bytes.drain(..(cursor - front.offset) as usize);
                front.offset = cursor;
            }
        }
        buffer.base = cursor;
        live.shared.space.notify_all();
        let mut chunks = Vec::new();
        let mut remaining = limit;
        let mut next = cursor;
        for chunk in &buffer.chunks {
            if remaining == 0 {
                break;
            }
            let count = remaining.min(chunk.bytes.len());
            chunks.push(json!({"channel":chunk.channel,"offset":chunk.offset,"bytesBase64":BASE64.encode(&chunk.bytes[..count])}));
            next += count as u64;
            remaining -= count;
        }
        Ok(
            json!({"chunks":chunks,"nextCursor":next,"endCursor":buffer.end,
            "inputSequence":buffer.input_sequence,"inputError":buffer.input_error}),
        )
    }
    pub(crate) fn write(
        &mut self,
        id: &str,
        sequence: i64,
        bytes: &str,
        eof: bool,
    ) -> Result<Value, KernelError> {
        let live = self
            .live
            .get_mut(id)
            .ok_or_else(|| failure("process handle is not live in this epoch"))?;
        if live.guardian_exited || live.requested_stop {
            return Err(failure("process is stopping or exited"));
        }
        let decoded = BASE64
            .decode(bytes)
            .map_err(|_| failure("stdin bytes are not valid base64"))?;
        if decoded.len() > CHUNK_BYTES {
            return Err(failure("stdin chunk exceeds the native transport bound"));
        }
        let hash = hash_json(&json!({"bytes":bytes,"eof":eof}))?;
        let mut buffer = live.shared.lock();
        if sequence == buffer.queued_sequence && hash == buffer.input_hash {
            return Ok(json!({"queued":true,"sequence":sequence}));
        }
        if sequence != buffer.queued_sequence + 1 || buffer.queued_sequence != buffer.input_sequence
        {
            return Err(failure(
                "process stdin sequence is stale or awaiting its write receipt",
            ));
        }
        live.input
            .as_ref()
            .ok_or_else(|| failure("process input is closed"))?
            .try_send(json!({"type":"write","sequence":sequence,"bytesBase64":bytes,"eof":eof}))
            .map_err(|_| failure("process control backpressure; stdin was not queued"))?;
        buffer.queued_sequence = sequence;
        buffer.input_hash = hash;
        Ok(json!({"queued":true,"sequence":sequence}))
    }
    pub(crate) fn resize(&mut self, id: &str, cols: u16, rows: u16) -> Result<Value, KernelError> {
        let live = self
            .live
            .get(id)
            .ok_or_else(|| failure("process handle is not live in this epoch"))?;
        live.input
            .as_ref()
            .ok_or_else(|| failure("process input is closed"))?
            .try_send(json!({"type":"resize","cols":cols,"rows":rows}))
            .map_err(|_| failure("process control backpressure; resize was not queued"))?;
        Ok(json!({"queued":true}))
    }
    pub(crate) fn kill(&mut self, id: &str, force: bool) -> Result<Value, KernelError> {
        let live = self
            .live
            .get_mut(id)
            .ok_or_else(|| failure("process handle is not live in this epoch"))?;
        if !live.guardian_exited {
            live.containment.terminate(&live.guardian, force)?;
            live.requested_stop = true;
        }
        Ok(json!({"requested":true,"exited":false}))
    }
    pub(crate) fn release(&mut self, id: &str) {
        if let Some(live) = self.live.remove(id) {
            live.shared.lock().discard = true;
            live.shared.space.notify_all();
        }
    }
    pub(crate) fn shutdown(&mut self) -> Result<(), KernelError> {
        for live in self.live.values_mut() {
            live.shared.lock().discard = true;
            live.shared.space.notify_all();
            // EOF is a native guardian stop request, not a fabricated exit.
            live.input.take();
            if !live.guardian_exited {
                let _ = live.containment.terminate(&live.guardian, true);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut pending = false;
            let ids: Vec<_> = self.live.keys().cloned().collect();
            for id in ids {
                if self
                    .observation(&id)?
                    .is_some_and(|value| value["writerActive"].as_bool() != Some(false))
                {
                    pending = true;
                }
            }
            if !pending {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(failure(
                    "native process exit remains unconfirmed; durable writers are retained",
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for ProcessManager {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}
