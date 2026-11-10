//! Temporary control of the default Windows playback endpoint.

use std::ptr;

use windows::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eMultimedia, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

use crate::CaptureError;

/// Mutes the default output until this guard is restored or dropped.
///
/// If the endpoint was already muted, no guard is returned because this app did
/// not change anything and therefore must not unmute it later.
pub struct OutputMuteGuard {
    restored: bool,
}

impl OutputMuteGuard {
    pub fn restore(&mut self) -> Result<(), CaptureError> {
        if self.restored {
            return Ok(());
        }
        set_default_output_mute(false)?;
        self.restored = true;
        tracing::info!("restored Windows default output mute state");
        Ok(())
    }
}

impl Drop for OutputMuteGuard {
    fn drop(&mut self) {
        if let Err(error) = self.restore() {
            tracing::error!(%error, "failed to restore Windows default output mute state");
        }
    }
}

pub fn mute_default_output() -> Result<Option<OutputMuteGuard>, CaptureError> {
    let was_muted = default_output_mute()?;
    if was_muted {
        tracing::info!("Windows default output was already muted; leaving it unchanged");
        return Ok(None);
    }

    set_default_output_mute(true)?;
    tracing::info!("muted Windows default output while AirPlay streaming is active");
    Ok(Some(OutputMuteGuard { restored: false }))
}

fn default_output_mute() -> Result<bool, CaptureError> {
    with_endpoint_volume(|volume| unsafe { volume.GetMute().map(bool::from) })
}

fn set_default_output_mute(muted: bool) -> Result<(), CaptureError> {
    with_endpoint_volume(|volume| unsafe { volume.SetMute(muted, ptr::null()).map_err(Into::into) })
}

fn with_endpoint_volume<T>(
    operation: impl FnOnce(&IAudioEndpointVolume) -> windows::core::Result<T>,
) -> Result<T, CaptureError> {
    let com = ComScope::enter()?;
    let result: windows::core::Result<T> = (|| unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
        let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
        operation(&volume)
    })();
    drop(com);
    result.map_err(|error| CaptureError::Backend(format!("Windows output mute: {error}")))
}

struct ComScope {
    uninitialize: bool,
}

impl ComScope {
    fn enter() -> Result<Self, CaptureError> {
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result == S_OK || result == S_FALSE {
            Ok(Self { uninitialize: true })
        } else if result == RPC_E_CHANGED_MODE {
            // Tauri may already own COM initialization for this thread. COM is
            // still usable; we simply must not balance an initialization call.
            Ok(Self {
                uninitialize: false,
            })
        } else {
            Err(CaptureError::Backend(format!(
                "Windows output mute COM initialization failed: {result:?}"
            )))
        }
    }
}

impl Drop for ComScope {
    fn drop(&mut self) {
        if self.uninitialize {
            unsafe { CoUninitialize() };
        }
    }
}
