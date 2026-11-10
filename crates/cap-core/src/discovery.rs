use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use thiserror::Error;
use tokio::sync::mpsc;

const SVC_AIRPLAY: &str = "_airplay._tcp.local.";
const SVC_RAOP: &str = "_raop._tcp.local.";

fn service_display_name(fullname: &str, is_raop: bool) -> String {
    let service_name = fullname.split('.').next().unwrap_or("?");
    if is_raop {
        service_name
            .split_once('@')
            .map(|(_, name)| name)
            .unwrap_or(service_name)
            .to_string()
    } else {
        service_name.to_string()
    }
}

#[derive(Debug, Error)]
pub enum DiscoveryError {
    #[error("mDNS daemon error: {0}")]
    Daemon(#[from] mdns_sd::Error),
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    HomePod,
    AppleTv,
    AirportExpress,
    OtherAirPlay,
}

impl DeviceKind {
    fn from_model(model: Option<&str>) -> Self {
        match model {
            Some(m) if m.starts_with("AudioAccessory") => Self::HomePod,
            Some(m) if m.starts_with("AppleTV") => Self::AppleTv,
            Some(m) if m.starts_with("AirPort") => Self::AirportExpress,
            _ => Self::OtherAirPlay,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub host: String,
    pub addresses: Vec<IpAddr>,
    pub port: u16,
    pub kind: DeviceKind,
    pub model: Option<String>,
    pub features: Option<String>,
    pub supports_airplay2: bool,
}

pub struct Discovery {
    daemon: ServiceDaemon,
}

impl Discovery {
    pub fn new() -> Result<Self, DiscoveryError> {
        let daemon = ServiceDaemon::new()?;
        Ok(Self { daemon })
    }

    /// Inicia browsing y emite dispositivos por el canal según se descubren.
    /// Se cancela cerrando el receptor o llamando a `shutdown`.
    pub fn browse(&self) -> Result<mpsc::UnboundedReceiver<Device>, DiscoveryError> {
        let (tx, rx) = mpsc::unbounded_channel();

        for svc in [SVC_AIRPLAY, SVC_RAOP] {
            let receiver = self.daemon.browse(svc)?;
            let tx = tx.clone();
            let svc_label = svc.to_string();
            tokio::spawn(async move {
                while let Ok(event) = receiver.recv_async().await {
                    if let ServiceEvent::ServiceResolved(info) = event {
                        let txt: HashMap<String, String> = info
                            .get_properties()
                            .iter()
                            .map(|p| (p.key().to_string(), p.val_str().to_string()))
                            .collect();

                        let model = txt.get("model").cloned();
                        let features = txt.get("features").or_else(|| txt.get("ft")).cloned();
                        let supports_airplay2 = txt
                            .get("srcvers")
                            .map(|v| v.starts_with("3"))
                            .unwrap_or(false)
                            || features
                                .as_ref()
                                .map(|f| f.contains("0x"))
                                .unwrap_or(false);

                        let addresses: Vec<IpAddr> = info.get_addresses().iter().copied().collect();
                        let is_raop = svc_label == SVC_RAOP;

                        let device = Device {
                            // A HomePod advertises both _airplay and _raop. Both
                            // records resolve to the same host/port, so use that
                            // endpoint as the stable UI identity instead of
                            // showing the physical speaker twice.
                            id: format!(
                                "{}:{}",
                                info.get_hostname().to_ascii_lowercase(),
                                info.get_port()
                            ),
                            name: service_display_name(info.get_fullname(), is_raop),
                            host: info.get_hostname().to_string(),
                            addresses,
                            port: info.get_port(),
                            kind: DeviceKind::from_model(model.as_deref()),
                            model,
                            features,
                            supports_airplay2,
                        };

                        tracing::debug!(svc = %svc_label, ?device, "discovered device");

                        if tx.send(device).is_err() {
                            break;
                        }
                    }
                }
            });
        }

        Ok(rx)
    }

    pub fn shutdown(&self) {
        let _ = self.daemon.shutdown();
    }
}

/// Lanza un browse de una sola pasada con timeout y devuelve la lista acumulada.
/// Útil para tests y para el primer fetch de la UI.
pub async fn browse_once(timeout: Duration) -> Result<Vec<Device>, DiscoveryError> {
    let discovery = Discovery::new()?;
    let mut rx = discovery.browse()?;

    let mut devices: HashMap<String, Device> = HashMap::new();
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => break,
            maybe = rx.recv() => {
                match maybe {
                    Some(device) => { devices.insert(device.id.clone(), device); }
                    None => break,
                }
            }
        }
    }

    discovery.shutdown();
    Ok(devices.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::service_display_name;

    #[test]
    fn strips_raop_hardware_prefix() {
        assert_eq!(
            service_display_name("52E8461C0EBE@Living Room._raop._tcp.local.", true),
            "Living Room"
        );
    }

    #[test]
    fn preserves_airplay_name() {
        assert_eq!(
            service_display_name("Living Room._airplay._tcp.local.", false),
            "Living Room"
        );
    }
}
