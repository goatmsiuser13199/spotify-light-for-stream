//! Diffusion AirPlay 2 (HomePod) — stack HomeListen (GPL-2.0).
//! Capture = process loopback de cette app (+ WebView2), pas le PC entier.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use cap_core::{
  browse_once,
  pairing::DeviceDescriptor,
  streaming::{open_live_stream, LatencyProfile},
  Device, Discovery,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct DiscoveryState {
  inner: Mutex<Option<Discovery>>,
  cache: Mutex<HashMap<String, Device>>,
}

struct ActiveStream {
  connection: std::sync::Arc<tokio::sync::Mutex<cap_core::streaming::Connection>>,
  _heartbeat: cap_core::streaming::HeartbeatGuard,
  _capture: Box<dyn audio_capture::Capture>,
  pump: Option<std::thread::JoinHandle<()>>,
  stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
  output_mute: Option<audio_capture::OutputMuteGuard>,
  ip: String,
  name: String,
  sample_rate: u32,
  channels: u8,
  volume: f32,
}

impl ActiveStream {
  fn stop_local(&mut self) {
    self.stop
      .store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(handle) = self.pump.take() {
      let _ = handle.join();
    }
    self._heartbeat.shutdown();
  }

  async fn shutdown(&mut self) -> Result<(), String> {
    self.stop_local();
    let restore_result = match self.output_mute.as_mut() {
      Some(mute) => mute.restore().map_err(|e| e.to_string()),
      None => Ok(()),
    };
    let mut connection = self.connection.lock().await;
    match tokio::time::timeout(Duration::from_secs(2), connection.disconnect()).await {
      Ok(Ok(())) => {}
      Ok(Err(error)) => {
        log::warn!("AirPlay disconnect failed: {error}");
      }
      Err(_) => {
        log::warn!("AirPlay disconnect timed out");
      }
    }
    restore_result
  }
}

impl Drop for ActiveStream {
  fn drop(&mut self) {
    self.stop_local();
  }
}

#[derive(Default)]
pub struct StreamingState {
  inner: tokio::sync::Mutex<Option<ActiveStream>>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamingInfo {
  ip: String,
  name: String,
  sample_rate: u32,
  channels: u8,
  volume: f32,
}

#[tauri::command]
pub async fn discover_devices(timeout_ms: Option<u64>) -> Result<Vec<Device>, String> {
  let timeout = Duration::from_millis(timeout_ms.unwrap_or(3_000));
  browse_once(timeout).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_discovery_stream(
  app: AppHandle,
  state: State<'_, DiscoveryState>,
) -> Result<(), String> {
  let cached: Vec<Device> = state
    .cache
    .lock()
    .map_err(|e| e.to_string())?
    .values()
    .cloned()
    .collect();
  for device in &cached {
    let _ = app.emit("airplay://device", device);
  }

  let mut rx = {
    let mut slot = state.inner.lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
      return Ok(());
    }
    let discovery = Discovery::new().map_err(|e| e.to_string())?;
    let rx = discovery.browse().map_err(|e| e.to_string())?;
    *slot = Some(discovery);
    rx
  };

  let app_pump = app.clone();
  tauri::async_runtime::spawn(async move {
    while let Some(device) = rx.recv().await {
      if let Some(state) = app_pump.try_state::<DiscoveryState>() {
        if let Ok(mut cache) = state.cache.lock() {
          cache.insert(device.id.clone(), device.clone());
        }
      }
      if app_pump.emit("airplay://device", &device).is_err() {
        break;
      }
    }
  });

  Ok(())
}

#[tauri::command]
pub async fn stop_discovery_stream(state: State<'_, DiscoveryState>) -> Result<(), String> {
  let mut slot = state.inner.lock().map_err(|e| e.to_string())?;
  if let Some(discovery) = slot.take() {
    discovery.shutdown();
  }
  Ok(())
}

#[tauri::command]
pub async fn start_streaming(
  app: AppHandle,
  ip: String,
  port: Option<u16>,
  name: Option<String>,
  model: Option<String>,
  features: Option<String>,
  volume: Option<f32>,
  play_locally: Option<bool>,
  // Id IMMDevice de la sortie PC (`default` ok).
  capture_device_id: Option<String>,
  state: State<'_, StreamingState>,
) -> Result<StreamingInfo, String> {
  use audio_capture::CaptureFormat;
  use std::sync::atomic::AtomicBool;
  use std::sync::Arc;

  let parsed: std::net::IpAddr = ip.parse().map_err(|e| format!("IP invalide: {e}"))?;
  let port = port.unwrap_or(7000);
  let display_name = name
    .clone()
    .unwrap_or_else(|| format!("HomePod {parsed}"));
  // 0.20 par défaut côté stack = trop bas sur beaucoup de HomePod → 0.55
  let target_volume = volume.unwrap_or(0.55).clamp(0.0, 1.0);

  let previous = {
    let mut slot = state.inner.lock().await;
    slot.take()
  };
  if let Some(mut previous) = previous {
    previous.shutdown().await?;
  }

  // WebView2 / Spotify SDK : le process-loopback est souvent silencieux.
  // On capture le loopback WASAPI de la sortie où l’app joue (comme HomeListen),
  // après avoir forcé le routage app+WebView2 vers ce périphérique.
  let sink = capture_device_id
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .unwrap_or("default");
  match crate::win_audio::set_output(sink) {
    Ok(msg) => log::info!("AirPlay route audio → {sink} | {msg}"),
    Err(e) => log::warn!("AirPlay route audio ({sink}): {e} — capture quand même"),
  }
  // Laisse Windows ouvrir la session audio sur ce device.
  tokio::time::sleep(Duration::from_millis(250)).await;

  let (capture, rx) =
    audio_capture::start_device_loopback(sink, CaptureFormat::AIRPLAY_DEFAULT)
      .map_err(|e| format!("capture audio: {e}"))?;

  let descriptor = DeviceDescriptor {
    ip: parsed,
    port,
    name: display_name.clone(),
    mac: None,
    model,
    features,
  };
  let stream_handle =
    open_live_stream(descriptor, Some(target_volume), Some(LatencyProfile::Music))
      .await
      .map_err(|e| format!("stream: {e}"))?;
  let (sender, connection, mut heartbeat, sample_rate, channels) = stream_handle.into_parts();

  // Si on ne garde pas le son PC : mute la sortie Windows par défaut
  // (les autres apps sur ce device sont aussi coupées tant que le stream tourne).
  let output_mute = if play_locally.unwrap_or(true) {
    None
  } else {
    match audio_capture::mute_default_output() {
      Ok(mute) => mute,
      Err(error) => {
        heartbeat.shutdown();
        let mut connection = connection.lock().await;
        let _ = connection.disconnect().await;
        return Err(format!("mute sortie Windows: {error}"));
      }
    }
  };

  let stop = Arc::new(AtomicBool::new(false));
  let stop_thread = stop.clone();
  let app_pump = app.clone();
  let pump = std::thread::Builder::new()
    .name("airplay-pump".into())
    .spawn(move || pump_loop(app_pump, rx, sender, sample_rate, channels, stop_thread))
    .map_err(|e| format!("pump thread: {e}"))?;

  let info = StreamingInfo {
    ip: parsed.to_string(),
    name: display_name.clone(),
    sample_rate,
    channels,
    volume: target_volume,
  };

  let active = ActiveStream {
    connection,
    _heartbeat: heartbeat,
    _capture: capture,
    pump: Some(pump),
    stop,
    output_mute,
    ip: parsed.to_string(),
    name: display_name,
    sample_rate,
    channels,
    volume: target_volume,
  };

  let mut slot = state.inner.lock().await;
  *slot = Some(active);

  Ok(info)
}

fn pump_loop(
  app: AppHandle,
  rx: crossbeam_channel::Receiver<audio_capture::CapturedFrame>,
  sender: cap_core::streaming::LiveFrameSender,
  sample_rate: u32,
  channels: u8,
  stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
  use cap_core::streaming::LivePcmFrame;
  use std::sync::atomic::Ordering;

  let mut unexpected_exit = false;
  let mut frames: u64 = 0;
  let mut peak: i16 = 0;
  let mut last_report = std::time::Instant::now();
  let mut silence_warned = false;

  while !stop.load(Ordering::SeqCst) {
    match rx.recv_timeout(Duration::from_millis(200)) {
      Ok(frame) => {
        for &s in &frame.samples {
          let a = s.saturating_abs();
          if a > peak {
            peak = a;
          }
        }
        frames += 1;
        let _ = sender.try_send(LivePcmFrame {
          samples: frame.samples,
          channels,
          sample_rate,
        });
      }
      Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
      Err(_) => {
        unexpected_exit = true;
        break;
      }
    }

    if last_report.elapsed() >= Duration::from_secs(2) {
      log::info!("airplay-pump: {frames} frames / 2s, peak={peak}");
      if frames > 0 && peak < 200 && !silence_warned {
        silence_warned = true;
        log::warn!("AirPlay: capture quasi silencieuse — piste en pause ou mauvaise sortie PC ?");
      }
      frames = 0;
      peak = 0;
      last_report = std::time::Instant::now();
    }
  }

  if unexpected_exit {
    log::warn!("airplay-pump: capture channel closed");
    let _ = app.emit(
      "airplay://error",
      "Capture audio interrompue (périphérique déconnecté ?)",
    );
  }
}

#[tauri::command]
pub async fn stop_streaming(state: State<'_, StreamingState>) -> Result<(), String> {
  let active = {
    let mut slot = state.inner.lock().await;
    slot.take()
  };
  if let Some(mut active) = active {
    active.shutdown().await?;
  }
  Ok(())
}

#[tauri::command]
pub async fn set_stream_volume(volume: f32, state: State<'_, StreamingState>) -> Result<f32, String> {
  let mut slot = state.inner.lock().await;
  let active = slot
    .as_mut()
    .ok_or_else(|| "aucun stream AirPlay actif".to_string())?;
  let v = volume.clamp(0.0, 1.0);
  let mut conn = active.connection.lock().await;
  conn.set_volume(v).await.map_err(|e| e.to_string())?;
  active.volume = v;
  Ok(v)
}

#[tauri::command]
pub async fn set_play_locally(
  play_locally: bool,
  state: State<'_, StreamingState>,
) -> Result<(), String> {
  let mut slot = state.inner.lock().await;
  let active = slot
    .as_mut()
    .ok_or_else(|| "aucun stream AirPlay actif".to_string())?;

  if play_locally {
    if let Some(mut mute) = active.output_mute.take() {
      if let Err(error) = mute.restore() {
        active.output_mute = Some(mute);
        return Err(error.to_string());
      }
    }
  } else if active.output_mute.is_none() {
    active.output_mute = audio_capture::mute_default_output().map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[tauri::command]
pub async fn is_streaming(state: State<'_, StreamingState>) -> Result<Option<StreamingInfo>, String> {
  let slot = state.inner.lock().await;
  Ok(slot.as_ref().map(|a| StreamingInfo {
    ip: a.ip.clone(),
    name: a.name.clone(),
    sample_rate: a.sample_rate,
    channels: a.channels,
    volume: a.volume,
  }))
}
