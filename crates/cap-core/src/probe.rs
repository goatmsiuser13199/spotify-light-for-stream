//! Verificación de un dispositivo AirPlay por IP (sin pasar por mDNS).
//!
//! En redes donde mDNS no se propaga (típicamente routers que no reflejan
//! multicast entre las bandas 2.4 y 5 GHz, o redes corporativas), el usuario
//! introduce la IP del HomePod manualmente. Antes de aceptarla hacemos:
//!
//! 1. Un connect TCP al puerto AirPlay (7000 por defecto). Si falla, no hay
//!    nada útil escuchando ahí.
//! 2. Un `OPTIONS * RTSP/1.0` con cabecera `User-Agent`. AirPlay 2 responde
//!    `RTSP/1.0 200 OK` con cabeceras propias (`Server: AirTunes/...`).
//!
//! Esto basta para confirmar que el endpoint es un receptor AirPlay y para
//! sacar la versión (firmware) que el HomePod expone.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use ap2rs_core::features::Features;
use serde::Deserialize;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::discovery::{Device, DeviceKind};

pub const DEFAULT_AIRPLAY_PORT: u16 = 7000;

#[derive(Debug, Error)]
pub enum ProbeError {
    #[error("connection to {addr} failed: {source}")]
    Connect {
        addr: SocketAddr,
        #[source]
        source: std::io::Error,
    },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("timeout after {0:?}")]
    Timeout(Duration),
    #[error("response is not an RTSP/AirPlay reply: {0}")]
    NotAirPlay(String),
    #[error("invalid AirPlay /info response: {0}")]
    InvalidInfo(String),
}

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub server_header: Option<String>,
    pub raw_response: String,
    pub model: Option<String>,
    pub features: Option<String>,
    pub name: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InfoResponse {
    features: Option<u64>,
    model: Option<String>,
    name: Option<String>,
    #[serde(rename = "deviceID")]
    device_id: Option<String>,
}

struct RawRtspResponse {
    headers: String,
    body: Vec<u8>,
}

fn header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

fn content_length(headers: &str) -> usize {
    headers
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("Content-Length")
                .then(|| value.trim().parse().ok())
                .flatten()
        })
        .unwrap_or(0)
}

async fn send_rtsp_request(
    addr: SocketAddr,
    request: &str,
    connect_timeout: Duration,
    response_timeout: Duration,
) -> Result<RawRtspResponse, ProbeError> {
    let mut stream = timeout(connect_timeout, TcpStream::connect(addr))
        .await
        .map_err(|_| ProbeError::Timeout(connect_timeout))?
        .map_err(|source| ProbeError::Connect { addr, source })?;

    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;

    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let deadline = tokio::time::Instant::now() + response_timeout;
    let (headers_end, expected_len) = loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .ok_or(ProbeError::Timeout(response_timeout))?;
        let n = timeout(remaining, stream.read(&mut chunk))
            .await
            .map_err(|_| ProbeError::Timeout(response_timeout))??;
        if n == 0 {
            return Err(ProbeError::NotAirPlay(
                "connection closed before RTSP headers".into(),
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > 1024 * 1024 {
            return Err(ProbeError::NotAirPlay(
                "response is larger than 1 MiB".into(),
            ));
        }
        if let Some(end) = header_end(&buf) {
            let headers = String::from_utf8_lossy(&buf[..end]).to_string();
            break (end, content_length(&headers));
        }
    };

    let body_start = headers_end + 4;
    while buf.len() < body_start + expected_len {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .ok_or(ProbeError::Timeout(response_timeout))?;
        let n = timeout(remaining, stream.read(&mut chunk))
            .await
            .map_err(|_| ProbeError::Timeout(response_timeout))??;
        if n == 0 {
            return Err(ProbeError::NotAirPlay("response body ended early".into()));
        }
        buf.extend_from_slice(&chunk[..n]);
    }

    let headers = String::from_utf8_lossy(&buf[..headers_end]).to_string();
    let status = headers.lines().next().unwrap_or("");
    let status_ok = status
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .map(|code| (200..300).contains(&code))
        .unwrap_or(false);
    if !status.starts_with("RTSP/1.0") || !status_ok {
        return Err(ProbeError::NotAirPlay(status.to_string()));
    }

    Ok(RawRtspResponse {
        headers,
        body: buf[body_start..body_start + expected_len].to_vec(),
    })
}

fn parse_info(body: &[u8]) -> Result<InfoResponse, ProbeError> {
    if body.is_empty() {
        return Err(ProbeError::InvalidInfo("empty body".into()));
    }
    plist::from_bytes(body).map_err(|e| ProbeError::InvalidInfo(e.to_string()))
}

/// Conecta a `ip:port` y emite un OPTIONS RTSP para confirmar AirPlay.
pub async fn probe_airplay(ip: IpAddr, port: u16) -> Result<ProbeResult, ProbeError> {
    let addr = SocketAddr::new(ip, port);
    let connect_timeout = Duration::from_secs(2);
    let response_timeout = Duration::from_secs(3);

    let options_request = format!(
        "OPTIONS * RTSP/1.0\r\n\
         CSeq: 1\r\n\
         User-Agent: ConexionAirPlay/0.1\r\n\
         \r\n"
    );
    let options =
        send_rtsp_request(addr, &options_request, connect_timeout, response_timeout).await?;

    let server_header = options.headers.lines().find_map(|line| {
        let mut parts = line.splitn(2, ':');
        let key = parts.next()?.trim();
        let val = parts.next()?.trim();
        key.eq_ignore_ascii_case("Server").then(|| val.to_string())
    });

    let info_request = "GET /info RTSP/1.0\r\n\
        CSeq: 2\r\n\
        User-Agent: AirPlay/745.83\r\n\
        Accept: application/x-apple-binary-plist\r\n\
        \r\n";
    let info = match send_rtsp_request(addr, info_request, connect_timeout, response_timeout).await
    {
        Ok(response) => match parse_info(&response.body) {
            Ok(info) => Some(info),
            Err(error) => {
                tracing::warn!(%error, "manual AirPlay probe could not parse /info metadata");
                None
            }
        },
        Err(error) => {
            tracing::warn!(%error, "manual AirPlay probe could not read /info metadata");
            None
        }
    };

    Ok(ProbeResult {
        server_header,
        raw_response: options.headers,
        model: info.as_ref().and_then(|value| value.model.clone()),
        features: info
            .as_ref()
            .and_then(|value| value.features)
            .map(|value| Features::from_raw(value).to_txt_value()),
        name: info.as_ref().and_then(|value| value.name.clone()),
        device_id: info.and_then(|value| value.device_id),
    })
}

/// Construye un `Device` "manual" a partir de una IP y opcionalmente nombre/puerto.
/// No marca `supports_airplay2 = true` hasta que el probe lo confirme.
pub fn manual_device(ip: IpAddr, port: Option<u16>, name: Option<String>) -> Device {
    let port = port.unwrap_or(DEFAULT_AIRPLAY_PORT);
    let display = name.unwrap_or_else(|| format!("Dispositivo manual {ip}"));
    Device {
        id: format!("manual://{ip}:{port}"),
        name: display,
        host: ip.to_string(),
        addresses: vec![ip],
        port,
        kind: DeviceKind::OtherAirPlay,
        model: None,
        features: None,
        supports_airplay2: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_homepod_info_metadata() {
        let raw_features = 0x3C35_4BD0_4A7F_CA00u64;
        let mut dict = plist::Dictionary::new();
        dict.insert("features".into(), plist::Value::from(raw_features));
        dict.insert("model".into(), plist::Value::from("AudioAccessory5,1"));
        dict.insert("name".into(), plist::Value::from("Living Room"));
        dict.insert("deviceID".into(), plist::Value::from("52:E8:46:1C:0E:BE"));
        let mut body = Vec::new();
        plist::to_writer_binary(&mut body, &plist::Value::Dictionary(dict)).unwrap();

        let info = parse_info(&body).unwrap();

        assert_eq!(info.model.as_deref(), Some("AudioAccessory5,1"));
        assert_eq!(info.name.as_deref(), Some("Living Room"));
        assert_eq!(info.device_id.as_deref(), Some("52:E8:46:1C:0E:BE"));
        assert_eq!(
            info.features
                .map(|value| Features::from_raw(value).to_txt_value()),
            Some("0x4A7FCA00,0x3C354BD0".into())
        );
    }

    #[test]
    fn rejects_empty_info_body() {
        assert!(matches!(parse_info(&[]), Err(ProbeError::InvalidInfo(_))));
    }

    #[test]
    fn extracts_content_length_case_insensitively() {
        assert_eq!(content_length("RTSP/1.0 200 OK\r\ncontent-length: 42"), 42);
    }
}
