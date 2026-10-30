//! Routage audio Windows par processus (même API qu’EarTrumpet / SoundSwitch).
//! Le Web Playback SDK Spotify n’expose pas de setSinkId fiable → on force
//! la sortie de app.exe + msedgewebview2.exe via AudioPolicyConfig.

use std::ffi::c_void;
use std::ptr;

use serde::Serialize;
use sysinfo::{Pid, ProcessesToUpdate, System};
use windows::core::{GUID, HRESULT, HSTRING, PCWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
  eCommunications, eConsole, eMultimedia, eRender, EDataFlow, ERole, IMMDeviceEnumerator,
  MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
  CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
  COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

/// GUID interface rendu audio (DEVINTERFACE_AUDIO_RENDER).
const DEVINTERFACE_AUDIO_RENDER: &str = "{e6327cad-dcec-4949-ae8a-991e976a79d2}";

/// IIDs connus de IAudioPolicyConfigFactory (Win10 / Win11).
const POLICY_IID_PRE: GUID = GUID::from_u128(0x2a59116d_6c4f_45e0_a74f_707e3fef9258);
const POLICY_IID_21H2: GUID = GUID::from_u128(0xab3d4648_e242_459f_b02f_541c70306324);
const POLICY_IID_16299: GUID = GUID::from_u128(0x32aa8e18_6496_4e24_9f94_b800e7eccc45);

#[derive(Serialize, Clone)]
pub struct WinAudioOut {
  pub device_id: String,
  pub label: String,
}

type SetEndpointFn = unsafe extern "system" fn(
  this: *mut c_void,
  process_id: u32,
  flow: EDataFlow,
  role: ERole,
  device_id: *mut c_void, // HSTRING
) -> HRESULT;

struct ComGuard;
impl Drop for ComGuard {
  fn drop(&mut self) {
    unsafe {
      CoUninitialize();
    }
  }
}

fn ensure_com() -> Result<ComGuard, String> {
  unsafe {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
  }
  Ok(ComGuard)
}

fn propvariant_to_string(pv: &PROPVARIANT) -> Option<String> {
  unsafe {
    // VT_LPWSTR = 31
    if pv.Anonymous.Anonymous.vt.0 != 31 {
      return None;
    }
    let p = pv.Anonymous.Anonymous.Anonymous.pwszVal;
    if p.is_null() {
      return None;
    }
    PCWSTR(p.0).to_string().ok()
  }
}

fn to_policy_device_id(mmdevice_id: &str) -> String {
  format!(r"\\?\SWD#MMDEVAPI#{mmdevice_id}#{DEVINTERFACE_AUDIO_RENDER}")
}

pub fn list_outputs() -> Result<Vec<WinAudioOut>, String> {
  let _com = ensure_com()?;

  unsafe {
    let enumerator: IMMDeviceEnumerator =
      CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        .map_err(|e| format!("MMDeviceEnumerator: {e}"))?;

    let collection = enumerator
      .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
      .map_err(|e| format!("EnumAudioEndpoints: {e}"))?;

    let count = collection.GetCount().map_err(|e| e.to_string())?;
    let mut outs = Vec::with_capacity((count as usize) + 1);
    outs.push(WinAudioOut {
      device_id: "default".into(),
      label: "Sortie par défaut Windows".into(),
    });

    for i in 0..count {
      let device = match collection.Item(i) {
        Ok(d) => d,
        Err(_) => continue,
      };
      let id_pwstr = match device.GetId() {
        Ok(id) => id,
        Err(_) => continue,
      };
      let id = id_pwstr.to_string().unwrap_or_default();

      let label = device
        .OpenPropertyStore(STGM_READ)
        .ok()
        .and_then(|store: IPropertyStore| store.GetValue(&PKEY_Device_FriendlyName).ok())
        .and_then(|pv| propvariant_to_string(&pv))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("Sortie audio {}", i + 1));

      outs.push(WinAudioOut {
        device_id: id,
        label,
      });
    }

    Ok(outs)
  }
}

fn collect_pids() -> Vec<u32> {
  let mut sys = System::new();
  sys.refresh_processes(ProcessesToUpdate::All, true);
  let root = Pid::from_u32(std::process::id());
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
  tree.into_iter().map(|p| p.as_u32()).collect()
}

/// Active la factory AudioPolicyConfig et renvoie (factory_ptr, set_fn).
fn policy_set_fn() -> Result<(*mut c_void, SetEndpointFn), String> {
  unsafe {
    let lib = LoadLibraryW(windows::core::w!("AudioSes.dll"))
      .map_err(|e| format!("LoadLibrary AudioSes: {e}"))?;

    let proc = GetProcAddress(lib, windows::core::s!("DllGetActivationFactory"))
      .ok_or_else(|| "DllGetActivationFactory introuvable".to_string())?;

    type ActFactory =
      unsafe extern "system" fn(activatable: *mut c_void, factory: *mut *mut c_void) -> HRESULT;

    let act: ActFactory = std::mem::transmute(proc);

    let class_name = HSTRING::from("Windows.Media.Internal.AudioPolicyConfig");
    let mut factory: *mut c_void = ptr::null_mut();
    let class_raw: *mut c_void = std::mem::transmute_copy(&class_name);
    let hr = act(class_raw, &mut factory);
    if hr.is_err() || factory.is_null() {
      return Err(format!("DllGetActivationFactory failed: {hr:?}"));
    }

    // IInspectable vtable: QI, AddRef, Release, GetIids, ...
    let vtable = *(factory as *const *const *const c_void);
    type GetIidsFn = unsafe extern "system" fn(
      this: *mut c_void,
      count: *mut u32,
      iids: *mut *mut GUID,
    ) -> HRESULT;
    let get_iids: GetIidsFn = std::mem::transmute(*vtable.add(3));

    let mut count: u32 = 0;
    let mut iids: *mut GUID = ptr::null_mut();
    let hr = get_iids(factory, &mut count, &mut iids);
    if hr.is_err() || iids.is_null() || count == 0 {
      return Err(format!("GetIids failed: {hr:?}"));
    }

    let last = *iids.add((count - 1) as usize);
    CoTaskMemFree(Some(iids as *const c_void));

    let known = [POLICY_IID_PRE, POLICY_IID_21H2, POLICY_IID_16299];
    if !known.contains(&last) {
      return Err(format!("IID AudioPolicyConfig inconnu: {last:?}"));
    }

    type QiFn = unsafe extern "system" fn(
      this: *mut c_void,
      iid: *const GUID,
      out: *mut *mut c_void,
    ) -> HRESULT;
    let qi: QiFn = std::mem::transmute(*vtable.add(0));
    let mut typed: *mut c_void = ptr::null_mut();
    let hr = qi(factory, &last, &mut typed);
    if hr.is_err() || typed.is_null() {
      return Err(format!("QueryInterface policy failed: {hr:?}"));
    }

    type ReleaseFn = unsafe extern "system" fn(this: *mut c_void) -> u32;
    let release: ReleaseFn = std::mem::transmute(*vtable.add(2));
    release(factory);

    let typed_vt = *(typed as *const *const *const c_void);
    // Index 25 = SetPersistedDefaultAudioEndpoint
    let set_fn: SetEndpointFn = std::mem::transmute(*typed_vt.add(25));
    Ok((typed, set_fn))
  }
}

fn set_for_pid(
  set_fn: SetEndpointFn,
  factory: *mut c_void,
  pid: u32,
  policy_device_id: Option<&str>,
) -> bool {
  let roles = [eConsole, eMultimedia, eCommunications];
  let mut any = false;

  for role in roles {
    let hstring = match policy_device_id {
      Some(id) if !id.is_empty() && id != "default" => HSTRING::from(id),
      _ => HSTRING::new(),
    };
    let raw: *mut c_void = unsafe { std::mem::transmute_copy(&hstring) };
    let hr = unsafe { set_fn(factory, pid, eRender, role, raw) };
    if hr.is_ok() {
      any = true;
    }
  }
  any
}

/// Applique la sortie à tout l’arbre de processus (app + WebView2).
/// `device_id` = id IMMDevice (`{0.0.0.00000000}.…`) ou `"default"`.
pub fn set_output(device_id: &str) -> Result<String, String> {
  let _com = ensure_com()?;

  let policy_id = if device_id.is_empty() || device_id == "default" {
    None
  } else {
    Some(to_policy_device_id(device_id))
  };

  let (factory, set_fn) = policy_set_fn()?;
  let pids = collect_pids();
  let mut ok_count = 0usize;

  for pid in &pids {
    if set_for_pid(set_fn, factory, *pid, policy_id.as_deref()) {
      ok_count += 1;
    }
  }

  unsafe {
    let vtable = *(factory as *const *const *const c_void);
    type ReleaseFn = unsafe extern "system" fn(this: *mut c_void) -> u32;
    let release: ReleaseFn = std::mem::transmute(*vtable.add(2));
    release(factory);
  }

  if ok_count == 0 {
    return Err(
      "Windows n’a pas encore de session audio — lance une piste, puis re-choisis la sortie."
        .into(),
    );
  }

  Ok(format!(
    "Sortie Windows OK ({ok_count}/{} processus)",
    pids.len()
  ))
}
