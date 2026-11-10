//! WASAPI loopback capture (Windows).
//!
//! Captura el audio del *render device* default usando el flag LOOPBACK.
//! Aprovechamos `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` (el flag `convert=true` de
//! la wasapi-rs crate) para que Windows resamplee internamente a 44.1k i16
//! estéreo, evitando tener que meter `rubato` y mantener el pipeline simple.
//!
//! Funcionamiento:
//! 1. Hilo dedicado: inicializa COM (MTA), abre el render device default,
//!    arranca un IAudioClient en modo SHARED con LOOPBACK + AUTOCONVERTPCM
//!    pidiendo 44.1k/16/2ch.
//! 2. Loop event-driven: espera a `h_event`, drena el capture client a un
//!    VecDeque<u8>, y cada vez que hay ≥ CHUNK_FRAMES, parte un Vec<i16>
//!    y lo envía por el `crossbeam_channel<CapturedFrame>`.
//!
//! El handle (`WindowsCapture`) detiene el hilo al dropearse / `.stop()`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crossbeam_channel::{bounded, Receiver};
use wasapi::{
    get_default_device, initialize_mta, DeviceCollection, Direction, SampleType, ShareMode,
    WaveFormat,
};

use crate::{Capture, CaptureError, CaptureFormat, CapturedFrame};

/// Frames por chunk entregado aguas arriba. 352 frames @ 44.1k = ~8 ms,
/// exactamente un paquete RTP/ALAC (`frames_per_packet = 352`). Alinear el
/// chunk al tamaño de paquete del encoder hace que cada chunk se mapee 1:1 a un
/// paquete enviado: pacing regular hacia la red en vez de dejar restos (512
/// dejaba 160 frames colgando por chunk, jitter que vacía el buffer del
/// receptor y "robotiza"). Antes 512 (~11 ms) y 1024 (~23 ms) antes aún; cada
/// bajada recorta latencia de captura. Igualado con `READ_CHUNK_FRAMES` del
/// backend `parec` para que el pipeline vea el mismo tamaño en ambos OS.
const CHUNK_FRAMES: usize = 352;

/// Timeout del `wait_for_event` (ms). Si Windows deja de enviar eventos
/// durante este tiempo, salimos del loop con error (driver colgado, audio
/// device desconectado, etc.).
const EVENT_TIMEOUT_MS: u32 = 3_000;

pub struct WindowsCapture {
    name: String,
    running: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl Capture for WindowsCapture {
    fn name(&self) -> &str {
        &self.name
    }
    fn stop(mut self: Box<Self>) {
        self.shutdown();
    }
}

impl WindowsCapture {
    fn shutdown(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for WindowsCapture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

enum CaptureSource {
    /// Loopback du render device Windows default.
    SystemDefault,
    /// Loopback d’un IMMDevice précis (id `{0.0.0.00000000}.…`).
    DeviceId(String),
    /// Loopback d’un PID (+ enfants si `include_tree`).
    Process { pid: u32, include_tree: bool },
}

pub fn start(
    fmt: CaptureFormat,
) -> Result<(Box<dyn Capture>, Receiver<CapturedFrame>), CaptureError> {
    spawn_capture(CaptureSource::SystemDefault, fmt)
}

pub fn start_device(
    device_id: &str,
    fmt: CaptureFormat,
) -> Result<(Box<dyn Capture>, Receiver<CapturedFrame>), CaptureError> {
    let id = device_id.trim();
    if id.is_empty() || id.eq_ignore_ascii_case("default") {
        return start(fmt);
    }
    spawn_capture(CaptureSource::DeviceId(id.to_string()), fmt)
}

pub fn start_process(
    process_id: u32,
    include_tree: bool,
    fmt: CaptureFormat,
) -> Result<(Box<dyn Capture>, Receiver<CapturedFrame>), CaptureError> {
    spawn_capture(
        CaptureSource::Process {
            pid: process_id,
            include_tree,
        },
        fmt,
    )
}

fn find_render_device(device_id: &str) -> Result<wasapi::Device, String> {
    let collection =
        DeviceCollection::new(&Direction::Render).map_err(|e| format!("DeviceCollection: {e}"))?;
    let n = collection
        .get_nbr_devices()
        .map_err(|e| format!("get_nbr_devices: {e}"))?;
    for i in 0..n {
        let device = collection
            .get_device_at_index(i)
            .map_err(|e| format!("get_device_at_index({i}): {e}"))?;
        let id = device.get_id().unwrap_or_default();
        if id == device_id {
            return Ok(device);
        }
    }
    Err(format!("périphérique audio introuvable: {device_id}"))
}

fn spawn_capture(
    source: CaptureSource,
    fmt: CaptureFormat,
) -> Result<(Box<dyn Capture>, Receiver<CapturedFrame>), CaptureError> {
    if fmt.channels != 2 {
        return Err(CaptureError::UnsupportedConfig {
            wanted: fmt.sample_rate,
            channels: fmt.channels,
        });
    }

    let target_rate = fmt.sample_rate;
    let target_channels = fmt.channels;

    let (tx, rx) = bounded::<CapturedFrame>(64);
    let running = Arc::new(AtomicBool::new(true));
    let running_thread = running.clone();

    let (init_tx, init_rx) = std::sync::mpsc::sync_channel::<Result<String, String>>(1);

    let thread_name = match &source {
        CaptureSource::SystemDefault | CaptureSource::DeviceId(_) => "audio-capture-wasapi",
        CaptureSource::Process { .. } => "audio-capture-process",
    };

    let handle = thread::Builder::new()
        .name(thread_name.into())
        .spawn(move || {
            let result = capture_thread_main(
                source,
                running_thread,
                target_rate,
                target_channels,
                &init_tx,
                tx,
            );
            if let Err(e) = result {
                tracing::error!(error = %e, "WASAPI capture thread exit con error");
                let _ = init_tx.send(Err(e));
            } else {
                tracing::info!("WASAPI capture thread exit limpio");
            }
        })
        .map_err(|e| CaptureError::Backend(format!("spawn capture thread: {e}")))?;

    let name = match init_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(name)) => name,
        Ok(Err(e)) => return Err(CaptureError::Backend(e)),
        Err(_) => {
            return Err(CaptureError::Backend(
                "WASAPI no completó init en 5 s".into(),
            ))
        }
    };

    Ok((
        Box::new(WindowsCapture {
            name,
            running,
            handle: Some(handle),
        }),
        rx,
    ))
}

fn capture_thread_main(
    source: CaptureSource,
    running: Arc<AtomicBool>,
    target_rate: u32,
    target_channels: u16,
    init_tx: &std::sync::mpsc::SyncSender<Result<String, String>>,
    tx: crossbeam_channel::Sender<CapturedFrame>,
) -> Result<(), String> {
    initialize_mta()
        .ok()
        .map_err(|e| format!("initialize_mta: {e}"))?;

    let desired_format = WaveFormat::new(
        16,
        16,
        &SampleType::Int,
        target_rate as usize,
        target_channels as usize,
        None,
    );
    let bytes_per_frame = desired_format.get_blockalign() as usize;

    let (mut audio_client, label, period) = match source {
        CaptureSource::SystemDefault => {
            let device = get_default_device(&Direction::Render)
                .map_err(|e| format!("get_default_device(Render): {e}"))?;
            let device_name = device
                .get_friendlyname()
                .unwrap_or_else(|_| "default render".to_string());
            tracing::info!(device = %device_name, "WASAPI system loopback");
            let client = device
                .get_iaudioclient()
                .map_err(|e| format!("get_iaudioclient: {e}"))?;
            let (def_period, _) = client
                .get_periods()
                .map_err(|e| format!("get_periods: {e}"))?;
            (client, device_name, def_period)
        }
        CaptureSource::DeviceId(id) => {
            let device = find_render_device(&id)?;
            let device_name = device
                .get_friendlyname()
                .unwrap_or_else(|_| id.clone());
            tracing::info!(device = %device_name, id = %id, "WASAPI device loopback");
            let client = device
                .get_iaudioclient()
                .map_err(|e| format!("get_iaudioclient: {e}"))?;
            let (def_period, _) = client
                .get_periods()
                .map_err(|e| format!("get_periods: {e}"))?;
            (client, device_name, def_period)
        }
        CaptureSource::Process { pid, include_tree } => {
            tracing::info!(pid, include_tree, "WASAPI process loopback");
            let client = wasapi::AudioClient::new_application_loopback_client(pid, include_tree)
                .map_err(|e| format!("process loopback client: {e}"))?;
            // get_periods / get_mixformat ne marchent pas en process loopback.
            (client, format!("process:{pid}"), 0_i64)
        }
    };

    audio_client
        .initialize_client(
            &desired_format,
            period,
            &Direction::Capture,
            &ShareMode::Shared,
            true,
        )
        .map_err(|e| format!("initialize_client (loopback): {e}"))?;

    let h_event = audio_client
        .set_get_eventhandle()
        .map_err(|e| format!("set_get_eventhandle: {e}"))?;

    let buffer_frame_count = audio_client.get_bufferframecount().unwrap_or(1024);
    tracing::info!(buffer_frames = buffer_frame_count, "WASAPI buffer size");

    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| format!("get_audiocaptureclient: {e}"))?;

    audio_client
        .start_stream()
        .map_err(|e| format!("start_stream: {e}"))?;

    let _ = init_tx.send(Ok(label));

    let mut byte_queue: VecDeque<u8> =
        VecDeque::with_capacity(bytes_per_frame * (buffer_frame_count as usize + CHUNK_FRAMES) * 4);

    let chunk_bytes = CHUNK_FRAMES * bytes_per_frame;

    while running.load(Ordering::SeqCst) {
        capture_client
            .read_from_device_to_deque(&mut byte_queue)
            .map_err(|e| format!("read_from_device_to_deque: {e}"))?;

        while byte_queue.len() >= chunk_bytes {
            let mut samples = Vec::with_capacity(CHUNK_FRAMES * target_channels as usize);
            for _ in 0..(CHUNK_FRAMES * target_channels as usize) {
                let lo = byte_queue.pop_front().unwrap();
                let hi = byte_queue.pop_front().unwrap();
                samples.push(i16::from_le_bytes([lo, hi]));
            }

            if tx
                .try_send(CapturedFrame {
                    samples,
                    channels: target_channels,
                    sample_rate: target_rate,
                })
                .is_err()
            {
                tracing::debug!("capture channel lleno, drop chunk");
            }
        }

        if h_event.wait_for_event(EVENT_TIMEOUT_MS).is_err() {
            if !running.load(Ordering::SeqCst) {
                break;
            }
            tracing::error!("wait_for_event timeout — driver de audio sin respuesta");
            let _ = audio_client.stop_stream();
            return Err("wait_for_event timeout".into());
        }
    }

    let _ = audio_client.stop_stream();
    Ok(())
}
