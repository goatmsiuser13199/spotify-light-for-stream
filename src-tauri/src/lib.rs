use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager};

mod win_audio;

const OAUTH_PORT: u16 = 5173;

static UI_HIDDEN: AtomicBool = AtomicBool::new(false);
/// Off par défaut : le sampling sysinfo provoquait des pics ~0.6 % sur app.exe.
static CPU_LOG_ENABLED: AtomicBool = AtomicBool::new(false);

static APP_HANDLE: Lazy<std::sync::Mutex<Option<AppHandle>>> =
  Lazy::new(|| std::sync::Mutex::new(None));

fn html_ok() -> &'static str {
  "<!doctype html><html><body style=\"font-family:sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0\"><p>Connexion OK — tu peux fermer cet onglet.</p><script>window.close()</script></body></html>"
}

fn html_err(msg: &str) -> String {
  format!(
    "<!doctype html><html><body style=\"font-family:sans-serif;background:#111;color:#e57373;display:grid;place-items:center;height:100vh;margin:0\"><p>Erreur: {}</p></body></html>",
    msg
  )
}

fn parse_query_param(request_line: &str, key: &str) -> Option<String> {
  let path = request_line.split_whitespace().nth(1)?;
  let query = path.split('?').nth(1)?;
  for pair in query.split('&') {
    let mut parts = pair.splitn(2, '=');
    let k = parts.next()?;
    let v = parts.next().unwrap_or("");
    if k == key {
      return Some(urlencoding_decode(v));
    }
  }
  None
}

fn urlencoding_decode(input: &str) -> String {
  let bytes = input.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    match bytes[i] {
      b'+' => {
        out.push(b' ');
        i += 1;
      }
      b'%' if i + 2 < bytes.len() => {
        let hex = &input[i + 1..i + 3];
        if let Ok(v) = u8::from_str_radix(hex, 16) {
          out.push(v);
          i += 3;
        } else {
          out.push(bytes[i]);
          i += 1;
        }
      }
      b => {
        out.push(b);
        i += 1;
      }
    }
  }
  String::from_utf8_lossy(&out).into_owned()
}

fn respond(stream: &mut std::net::TcpStream, status: &str, body: &str) {
  let response = format!(
    "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
    body.len()
  );
  let _ = stream.write_all(response.as_bytes());
}

fn now_stamp() -> String {
  let secs = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);
  format!("{secs}")
}

fn write_log_line(app: &AppHandle, level: &str, message: &str) {
  let Ok(dir) = app.path().app_log_dir() else {
    return;
  };
  let _ = std::fs::create_dir_all(&dir);
  let path = dir.join("spotify-light.log");
  let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
    return;
  };
  let _ = writeln!(file, "{} [{}] {}", now_stamp(), level, message);
}

fn collect_process_tree(sys: &System, root: Pid) -> Vec<Pid> {
  let mut tree = vec![root];
  let mut changed = true;
  while changed {
    changed = false;
    for (pid, proc) in sys.processes() {
      if tree.contains(pid) {
        continue;
      }
      if let Some(parent) = proc.parent() {
        if tree.contains(&parent) {
          tree.push(*pid);
          changed = true;
        }
      }
    }
  }
  tree
}

fn sample_and_log(app: &AppHandle, sys: &mut System) {
  if !CPU_LOG_ENABLED.load(Ordering::Relaxed) {
    return;
  }

  sys.refresh_cpu_all();
  sys.refresh_processes(ProcessesToUpdate::All, true);

  let our_pid = Pid::from_u32(std::process::id());
  let tree = collect_process_tree(sys, our_pid);

  let mut cpu_sum = 0.0_f32;
  let mut mem_sum = 0_u64;
  let mut details: Vec<String> = Vec::new();

  for pid in &tree {
    if let Some(proc) = sys.process(*pid) {
      let cpu = proc.cpu_usage();
      let mem_mb = proc.memory() / (1024 * 1024);
      cpu_sum += cpu;
      mem_sum += mem_mb;
      let name = proc.name().to_string_lossy();
      details.push(format!("{name}#{pid}={cpu:.1}%/{mem_mb}MB"));
    }
  }

  let hidden = UI_HIDDEN.load(Ordering::Relaxed);
  let mode = if hidden { "HIDDEN" } else { "VISIBLE" };
  let line = format!(
    "CPU_SAMPLE mode={mode} total_cpu={cpu_sum:.1}% total_mem={mem_sum}MB procs=[{}]",
    details.join(" | ")
  );
  write_log_line(app, "info", &line);
}

fn start_cpu_logger(app: AppHandle) {
  static STARTED: AtomicBool = AtomicBool::new(false);
  if STARTED.swap(true, Ordering::Relaxed) {
    return;
  }
  thread::spawn(move || {
    let mut sys = System::new();
    loop {
      if !CPU_LOG_ENABLED.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_secs(60));
        continue;
      }
      sys.refresh_cpu_all();
      sys.refresh_processes(ProcessesToUpdate::All, true);
      thread::sleep(Duration::from_millis(400));
      sample_and_log(&app, &mut sys);
      thread::sleep(Duration::from_secs(30));
    }
  });
}

#[tauri::command]
fn append_log(app: AppHandle, level: String, message: String) -> Result<(), String> {
  write_log_line(&app, &level, &message);
  Ok(())
}

#[tauri::command]
fn open_log_folder(app: AppHandle) -> Result<(), String> {
  let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  open::that(dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_ui_hidden(hidden: bool) -> Result<(), String> {
  UI_HIDDEN.store(hidden, Ordering::Relaxed);
  Ok(())
}

#[tauri::command]
fn set_cpu_logging(app: AppHandle, enabled: bool) -> Result<(), String> {
  let was = CPU_LOG_ENABLED.swap(enabled, Ordering::Relaxed);
  if enabled && !was {
    start_cpu_logger(app);
  }
  Ok(())
}

#[tauri::command]
fn start_oauth_listener(app: AppHandle) -> Result<(), String> {
  let listener = TcpListener::bind(("127.0.0.1", OAUTH_PORT))
    .map_err(|e| format!("Impossible d’ouvrir le port {OAUTH_PORT}: {e}"))?;

  let handle = app.clone();
  thread::spawn(move || {
    match listener.accept() {
      Ok((mut stream, _)) => {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let first_line = req.lines().next().unwrap_or("");

        if let Some(error) = parse_query_param(first_line, "error") {
          respond(&mut stream, "400 Bad Request", &html_err(&error));
          let _ = handle.emit("spotify-oauth-error", error);
          return;
        }

        if let Some(code) = parse_query_param(first_line, "code") {
          respond(&mut stream, "200 OK", html_ok());
          let _ = handle.emit("spotify-oauth-code", code);
        } else {
          respond(&mut stream, "400 Bad Request", &html_err("code manquant"));
          let _ = handle.emit("spotify-oauth-error", "code manquant");
        }
      }
      Err(e) => {
        let _ = handle.emit("spotify-oauth-error", e.to_string());
      }
    }
  });

  Ok(())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
  open::that(url).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_windows_sound_settings() -> Result<(), String> {
  open::that("ms-settings:sound").map_err(|e| e.to_string())
}

fn prefs_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir.join("prefs.json"))
}

#[tauri::command]
fn get_pref(app: AppHandle, key: String) -> Result<Option<String>, String> {
  let path = prefs_path(&app)?;
  if !path.exists() {
    return Ok(None);
  }
  let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
  let map: serde_json::Map<String, serde_json::Value> =
    serde_json::from_str(&text).unwrap_or_default();
  Ok(map.get(&key).and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| {
    // accepte aussi number
    v.as_f64().map(|n| n.to_string())
  })))
}

#[tauri::command]
fn set_pref(app: AppHandle, key: String, value: String) -> Result<(), String> {
  let path = prefs_path(&app)?;
  let mut map: serde_json::Map<String, serde_json::Value> = if path.exists() {
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
    serde_json::from_str(&text).unwrap_or_default()
  } else {
    serde_json::Map::new()
  };
  map.insert(key, serde_json::Value::String(value));
  let out = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
  std::fs::write(&path, out).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_windows_audio_outputs() -> Result<Vec<win_audio::WinAudioOut>, String> {
  win_audio::list_outputs()
}

#[tauri::command]
fn set_windows_audio_output(device_id: String) -> Result<String, String> {
  let msg = win_audio::set_output(&device_id)?;
  if let Ok(guard) = APP_HANDLE.lock() {
    if let Some(app) = guard.as_ref() {
      write_log_line(app, "info", &format!("WIN_AUDIO_OUT id={device_id} | {msg}"));
    }
  }
  Ok(msg)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      {
        let mut guard = APP_HANDLE.lock().map_err(|e| e.to_string())?;
        *guard = Some(app.handle().clone());
      }
      write_log_line(app.handle(), "info", "app started");
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      start_oauth_listener,
      open_url,
      append_log,
      open_log_folder,
      open_windows_sound_settings,
      list_windows_audio_outputs,
      set_windows_audio_output,
      get_pref,
      set_pref,
      set_ui_hidden,
      set_cpu_logging
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
