/**
 * Cloudflare Pages Function: /api/weather
 *
 * Proxies Ecowitt API calls (keeping keys server-side),
 * stores 48-hour rolling temperature & pressure history in KV,
 * and returns everything in a single JSON response to the browser.
 *
 * Required environment variables (set in Cloudflare Pages → Settings → Environment variables):
 *   ECOWITT_API_KEY         — your Ecowitt API key
 *   ECOWITT_APPLICATION_KEY — your Ecowitt application key
 *   ECOWITT_DEVICE_MAC      — your device MAC address
 *
 * Required KV namespace binding (set in Cloudflare Pages → Settings → Functions → KV namespace bindings):
 *   Binding name: WEATHER_KV
 */

const ECOWITT_BASE = 'https://api.ecowitt.net/api/v3/device';
const KV_HISTORY_KEY = 'trend_history';
const MAX_HISTORY_HOURS = 48;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

export async function onRequestGet({ env }) {
  // Validate environment is configured
  if (!env.ECOWITT_API_KEY || !env.ECOWITT_APPLICATION_KEY || !env.ECOWITT_DEVICE_MAC) {
    return jsonResponse({ error: 'Server misconfiguration: missing environment variables.' }, 500);
  }

  const apiKey = env.ECOWITT_API_KEY;
  const appKey = env.ECOWITT_APPLICATION_KEY;
  const mac = env.ECOWITT_DEVICE_MAC;

  // --- Fetch real-time and historical data from Ecowitt in parallel ---
  const [realtimeResult, historyResult] = await Promise.allSettled([
    fetchEcowitt(`${ECOWITT_BASE}/real_time?application_key=${appKey}&api_key=${apiKey}&mac=${mac}&call_back=all`),
    fetchEcowitt(buildHistoryUrl(appKey, apiKey, mac)),
  ]);

  if (realtimeResult.status === 'rejected') {
    return jsonResponse({ error: `Failed to reach Ecowitt API: ${realtimeResult.reason}` }, 502);
  }

  const realtimeData = realtimeResult.value;
  if (realtimeData.code !== 0) {
    return jsonResponse({ error: realtimeData.msg || 'Ecowitt API returned an error.' }, 502);
  }

  // Capture history result — include error details in response for debugging
  let historyData = null;
  let historyError = null;
  if (historyResult.status === 'fulfilled') {
    if (historyResult.value?.code === 0) {
      historyData = historyResult.value.data;
    } else {
      historyError = { code: historyResult.value?.code, msg: historyResult.value?.msg };
    }
  } else {
    historyError = { msg: historyResult.reason?.message || 'fetch failed' };
  }

  // --- Update KV trend history ---
  let trendHistory = { pressure: [], temperature: [] };
  if (env.WEATHER_KV) {
    trendHistory = await updateTrendHistory(env.WEATHER_KV, realtimeData.data);
  }

  return jsonResponse({
    realtime: realtimeData.data,
    history: historyData,
    history_error: historyError,  // null when successful — remove once confirmed working
    trends: trendHistory,
  });
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ecowitt history API expects dates as "YYYY-MM-DD HH:MM:SS" in the
 * station's local timezone. Lonehill is UTC+2 (Africa/Johannesburg).
 */
function buildHistoryUrl(appKey, apiKey, mac) {
  const toEcowittDate = (date) => {
    // Format in SAST (UTC+2) — Ecowitt interprets dates in local station time
    return date.toLocaleString('sv-SE', { timeZone: 'Africa/Johannesburg' }).replace('T', ' ');
  };

  const now   = new Date();
  const start = new Date(now.getTime() - 24 * 3600 * 1000);

  const endDate   = toEcowittDate(now);
  const startDate = toEcowittDate(start);

  return `${ECOWITT_BASE}/history?application_key=${appKey}&api_key=${apiKey}&mac=${mac}&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&cycle_type=30min&call_back=outdoor,pressure`;
}

async function fetchEcowitt(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Reads the rolling history from KV, appends the current reading,
 * trims to MAX_HISTORY_HOURS, writes it back, and returns it.
 */
async function updateTrendHistory(kv, realtimeData) {
  // Read existing history
  let history = { pressure: [], temperature: [] };
  try {
    const stored = await kv.get(KV_HISTORY_KEY, { type: 'json' });
    if (stored && stored.pressure && stored.temperature) {
      history = stored;
    }
  } catch (_) {
    // KV read failed — start fresh, don't crash
  }

  const now = Date.now();
  const cutoff = now - MAX_HISTORY_HOURS * 3600 * 1000;

  // Extract current values (Ecowitt returns imperial — convert to metric here on the server)
  const rawPressure = parseEcowittValue(realtimeData?.pressure?.relative);
  const rawTemp = parseEcowittValue(realtimeData?.outdoor?.temperature);

  if (rawPressure !== null) {
    history.pressure.push({ time: now, value: inHgToHPa(rawPressure) });
  }
  if (rawTemp !== null) {
    history.temperature.push({ time: now, value: fToC(rawTemp) });
  }

  // Trim to rolling window
  history.pressure = history.pressure.filter(p => p.time > cutoff);
  history.temperature = history.temperature.filter(t => t.time > cutoff);

  // Write back — use a 49-hour TTL so KV auto-cleans if the station goes offline
  try {
    await kv.put(KV_HISTORY_KEY, JSON.stringify(history), { expirationTtl: 49 * 3600 });
  } catch (_) {
    // KV write failed — return what we have, don't crash
  }

  return history;
}

// Unit conversion (same as client-side, but done once on the server)
const fToC = (f) => (f - 32) * 5 / 9;
const inHgToHPa = (inHg) => inHg * 33.8639;

/**
 * Safely extract a numeric value from an Ecowitt value object.
 * Returns null (not 0) when data is missing.
 */
function parseEcowittValue(obj) {
  if (obj == null || obj.value == null || obj.value === '') return null;
  const n = parseFloat(obj.value);
  return isNaN(n) ? null : n;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}
