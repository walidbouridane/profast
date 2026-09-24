//! ============================================================================
//!  ProFast Facture — CAPTURE DE L'EMPREINTE MATÉRIELLE (HWID)
//!  HWID = SHA-256( CPU ID | Carte mère (serial) | Adresse MAC physique )
//!
//!  Format : HWID-XXXX-XXXX-XXXX-XXXX  (64 bits lisibles, 100 % déterministe
//!  sur la même machine — même après redémarrage ; il change si le CPU, la
//!  carte mère ou le NIC principal est remplacé, ce qui verrouille la licence
//!  : c'est l'effet recherché).
//!
//!  Robustesse : si un composant est illisible (VM, DMI restreint, sandbox),
//!  il est remplacé par "UNKNOWN" — le HWID reste stable sur la machine.
//! ============================================================================

use sha2::{Digest, Sha256};

const UNKNOWN: &str = "UNKNOWN";

/// Calcule le HWID final de la machine.
pub fn compute_hwid() -> String {
    let raw = format!("{}|{}|{}", cpu_id(), board_serial(), mac_address());
    let digest = Sha256::digest(raw.as_bytes());
    let hex = hex::encode(digest);
    let t = hex[..16].to_uppercase();
    format!("HWID-{}-{}-{}-{}", &t[0..4], &t[4..8], &t[8..12], &t[12..16])
}

// ----------------------------------------------------------------------------
// CPU ID
// ----------------------------------------------------------------------------
fn cpu_id() -> String {
    #[cfg(target_os = "windows")]
    {
        wmi_query("SELECT ProcessorId FROM Win32_Processor", "ProcessorId")
            .unwrap_or_else(|| UNKNOWN.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        sysfile_first(
            &["/sys/class/dmi/id/chassis_serial", "/sys/class/dmi/id/product_serial"],
        )
        .or_else(|| cpuinfo_field(&["Serial", "Serial number", "Processor"]))
        .unwrap_or_else(|| UNKNOWN.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        // IOPlatformUUID — stable sur la durée de vie du Mac
        std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .find(|l| l.contains("IOPlatformUUID"))
                    .and_then(|l| l.split('"').nth(5).map(|s| s.to_string()))
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| UNKNOWN.to_string())
    }
}

/// Interroge WMI via PowerShell (Get-CimInstance) — wmic étant retiré de Windows.
#[cfg(target_os = "windows")]
fn wmi_query(select: &str, property: &str) -> Option<String> {
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-CimInstance -Query '{}').{} | Select-Object -First 1", select, property),
        ])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() || s.eq_ignore_ascii_case("Unknown") {
        None
    } else {
        Some(s)
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn sysfile_first(paths: &[&str]) -> Option<String> {
    for p in paths {
        if let Ok(s) = std::fs::read_to_string(p) {
            let s = s.trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

#[cfg(all(unix, not(target_os = "macos")))]
fn cpuinfo_field(names: &[&str]) -> Option<String> {
    let data = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    for name in names {
        for line in data.lines() {
            if let Some(rest) = line.strip_prefix(name) {
                let v = rest.split(':').nth(1)?.trim().to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    None
}

// ----------------------------------------------------------------------------
// Carte mère (serial)
// ----------------------------------------------------------------------------
fn board_serial() -> String {
    #[cfg(target_os = "windows")]
    {
        wmi_query("SELECT SerialNumber FROM Win32_BaseBoard", "SerialNumber")
            .or_else(|| wmi_query("SELECT SerialNumber FROM Win32_BIOS", "SerialNumber"))
            .unwrap_or_else(|| UNKNOWN.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        sysfile_first(&[
            "/sys/class/dmi/id/board_serial",
            "/sys/class/dmi/id/product_serial",
            "/sys/class/dmi/id/product_uuid",
        ])
        .unwrap_or_else(|| UNKNOWN.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("system_profiler")
            .args(["SPHardwareDataType", "-json"])
            .output()
            .ok()
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .split("\"Serial Number\" : ")
                    .nth(1)
                    .and_then(|s| s.split('"').next().map(|s| s.to_string()))
            })
            .unwrap_or_else(|| UNKNOWN.to_string())
    }
}

// ----------------------------------------------------------------------------
// Adresse MAC (adaptateur physique principal, non virtuel)
// ----------------------------------------------------------------------------
fn mac_address() -> String {
    // `mac_address` renvoie l'adresse physique de l'interface par défaut.
    // En production : énumérer TOUS les adapters, exclure les vendors virtuels
    // (VMware 000C29, VirtualBox 080027, Hyper-V, Cisco 001B67), trier et
    // concaténer les 2 premières pour résister au changement d'interface.
    match mac_address::get_mac_address() {
        Ok(Some(m)) => m.to_string().replace(':', ""),
        Ok(None) | Err(_) => UNKNOWN.to_string(),
    }
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hwid_format_and_stability() {
        let a = compute_hwid();
        let b = compute_hwid();
        assert_eq!(a, b, "le HWID doit être déterministe sur la même machine");
        assert!(a.starts_with("HWID-"));
        assert_eq!(a.len(), 24); // HWID-XXXX-XXXX-XXXX-XXXX
    }
}
