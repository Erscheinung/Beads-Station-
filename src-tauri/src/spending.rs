// Code-9d8 — LLM gateway spend aggregate.
//
// The per-session cost meter (claudeUsage.ts + CostMeter.tsx) already shows the
// live USD/token totals accumulated from Claude result frames. This module adds
// the daily/monthly AGGREGATE the Gateway popover shows (e.g. "4.79/50 EUR
// day, 114.91/500 EUR month").
//
// Data source: the same two endpoints the `gateway-spending-plugin` statusline uses
//   GET https://gateway.example.com/llm-proxy/client-api/v1/me/costs
//   GET https://gateway.example.com/llm-proxy/client-api/v1/me/caps
// authenticated with the Bearer access token the plugin caches at
//   ~/.config/gateway/spending-plugin-token.json  { access_token, exp }
//
// Per the Code-9d8 decision we do NOT reimplement the OIDC refresh / keychain
// rotation here — that lives in the plugin and its statusline refreshes the
// cache out-of-band. We READ the cached token; if it is missing or expired we
// return `Unavailable` and the FE simply omits the aggregate row rather than
// showing stale numbers. No subprocess spawn (R3.5: the GUI inherits an empty
// PATH under launchd).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://gateway.example.com";
const COSTS_PATH: &str = "/llm-proxy/client-api/v1/me/costs";
const CAPS_PATH: &str = "/llm-proxy/client-api/v1/me/caps";

fn token_cache_path() -> PathBuf {
    match std::env::var_os("HOME") {
        Some(home) => Path::new(&home).join(".config/gateway/spending-plugin-token.json"),
        None => PathBuf::from("~/.config/gateway/spending-plugin-token.json"),
    }
}

#[derive(Debug, Deserialize)]
struct TokenCache {
    access_token: Option<String>,
    /// Unix seconds. The plugin refreshes 60s before this; we treat within-60s
    /// as expired too so we never send a token about to be rejected.
    exp: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct CostsResp {
    current_day_eur: Option<f64>,
    current_month_eur: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct CapsResp {
    daily_limit_eur: Option<f64>,
    monthly_limit_eur: Option<f64>,
    plan_display: Option<String>,
    plan: Option<String>,
}

/// Shape returned to the FE. `available` is the single flag the CostMeter reads
/// to decide whether to render the aggregate row — when false the numbers are
/// meaningless and should not be shown.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySpend {
    pub available: bool,
    pub daily_eur: f64,
    pub monthly_eur: f64,
    pub daily_limit_eur: f64,
    pub monthly_limit_eur: f64,
    pub plan: String,
    /// Present only when `available` is false — a short reason for the log/FE.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl GatewaySpend {
    fn unavailable(reason: &str) -> Self {
        GatewaySpend {
            available: false,
            reason: Some(reason.to_string()),
            ..Default::default()
        }
    }
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// Read the cached access token, returning None if the file is missing,
/// unparseable, has no token, or the token is expired (within the 60s guard).
fn read_valid_token() -> Option<String> {
    let raw = std::fs::read_to_string(token_cache_path()).ok()?;
    let cache: TokenCache = serde_json::from_str(&raw).ok()?;
    let token = cache.access_token?;
    let exp = cache.exp?;
    if now_secs() < exp - 60.0 {
        Some(token)
    } else {
        None
    }
}

fn api_get<T: for<'de> Deserialize<'de>>(path: &str, token: &str) -> Result<T, String> {
    let url = format!("{API_BASE}{path}");
    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("GET {path}: {e}"))?;
    resp.into_json::<T>()
        .map_err(|e| format!("parse {path}: {e}"))
}

/// Fetch the Gateway daily/monthly spend aggregate. Never errors to the FE:
/// on any failure (no token, expired, network, non-200) it resolves to an
/// `available: false` value so the CostMeter row is simply omitted.
#[tauri::command]
pub fn gateway_spending() -> GatewaySpend {
    if !crate::envloader::gateway_enabled() {
        return GatewaySpend::unavailable("native CLI login; gateway spending disabled");
    }
    let token = match read_valid_token() {
        Some(t) => t,
        None => {
            tracing::info!("gateway_spending: no valid cached token (Code-9d8)");
            return GatewaySpend::unavailable("no valid token");
        }
    };

    let costs: CostsResp = match api_get(COSTS_PATH, &token) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("gateway_spending: costs fetch failed: {e}");
            return GatewaySpend::unavailable("costs fetch failed");
        }
    };
    let caps: CapsResp = match api_get(CAPS_PATH, &token) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("gateway_spending: caps fetch failed: {e}");
            return GatewaySpend::unavailable("caps fetch failed");
        }
    };

    GatewaySpend {
        available: true,
        daily_eur: costs.current_day_eur.unwrap_or(0.0),
        monthly_eur: costs.current_month_eur.unwrap_or(0.0),
        daily_limit_eur: caps.daily_limit_eur.unwrap_or(50.0),
        monthly_limit_eur: caps.monthly_limit_eur.unwrap_or(500.0),
        plan: caps.plan_display.or(caps.plan).unwrap_or_default(),
        reason: None,
    }
}
