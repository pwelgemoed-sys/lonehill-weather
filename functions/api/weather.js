/**
 * Cloudflare Pages Function: /api/weather
 *
 * Proxies Ecowitt API calls (keeping keys server-side),
 * stores 48-hour rolling temperature, pressure and dew point history in KV,
 * and returns everything in a single JSON response to the browser.
 *
 * Required environment variables:
 *   ECOWITT_API_KEY         — your Ecowitt API key
 *   ECOWITT_APPLICATION_KEY — your Ecowitt application key
 *   ECOWITT_DEVICE_MAC      — your device MAC address
 *
 * Required KV namespace binding:
 *   Binding name: WEATHER_KV
 */

const ECOWITT_BASE    = 'https://api.ecowitt.net/api/v3/device';
const KV_HISTORY_KEY  = 'trend_history';
const MAX_HISTORY_HOURS = 48;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://lonehill.pages.dev',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

export async function onRequestGet({ env }) {
  if (!env.ECOWITT_API_KEY || !env.ECOWITT_APPLICATION_KEY || !env.ECOWITT_DEVICE_MAC) {
    return jsonResponse({ error: 'Server misconfiguration: missing environment variables.' }, 500);
  }

  const apiKey = env.ECOWITT_API_KEY;
  const appKey = env.ECOWITT_APPLICATION_KEY;
  const mac    = env.ECOWITT_DEVICE_MAC;

  // Fetch real-time and 24h historical data in parallel
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

  const historyData = historyResult.status === 'fulfilled' && historyResult.value?.code === 0
    ? historyResult.value.data
    : null;

  // Update KV trend history (temperature + pressure + dew point)
  let trendHistory = { pressure: [], temperature: [], dewPoint: [] };
  if (env.WEATHER_KV) {
    trendHistory = await updateTrendHistory(env.WEATHER_KV, realtimeData.data);
  }

  return jsonResponse({
    realtime: realtimeData.data,
    history:  historyData,
    trends:   trendHistory,
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHistoryUrl(appKey, apiKey, mac) {
  const toEcowittDate = (date) =>
    date.toLocaleString('sv-SE', { timeZone: 'Africa/Johannesburg' }).replace('T', ' ');

  const now   = new Date();
  const start = new Date(now.getTime() - 24 * 3600 * 1000);

  return `${ECOWITT_BASE}/history?application_key=${appKey}&api_key=${apiKey}&mac=${mac}` +
    `&start_date=${encodeURIComponent(toEcowittDate(start))}` +
    `&end_date=${encodeURIComponent(toEcowittDate(now))}` +
    `&cycle_type=30min&call_back=outdoor,pressure`;
}

async function fetchEcowitt(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // Force UTF-8 — Ecowitt sometimes sends incorrect Content-Type header
  const buffer = await response.arrayBuffer();
  const text   = new TextDecoder('utf-8').decode(buffer);
  return JSON.parse(text);
}

async function updateTrendHistory(kv, realtimeData) {
  // Read stored history — backwards-compat: add dewPoint if missing from old records
  let history = { pressure: [], temperature: [], dewPoint: [] };
  try {
    const stored = await kv.get(KV_HISTORY_KEY, { type: 'json' });
    if (stored && stored.pressure && stored.temperature) {
      history = stored;
      if (!history.dewPoint) history.dewPoint = [];
    }
  } catch (_) { /* KV read failed — start fresh */ }

  const now    = Date.now();
  const cutoff = now - MAX_HISTORY_HOURS * 3600 * 1000;

  // Extract current readings (all converted to metric on the server side)
  const rawPressure  = parseEcowittValue(realtimeData?.pressure?.relative);
  const rawTemp      = parseEcowittValue(realtimeData?.outdoor?.temperature);
  const rawDewPoint  = parseEcowittValue(realtimeData?.outdoor?.dew_point);

  // Trim first, then push — so arrays never temporarily exceed window size
  history.pressure    = history.pressure.filter(p => p.time > cutoff);
  history.temperature = history.temperature.filter(t => t.time > cutoff);
  history.dewPoint    = history.dewPoint.filter(d => d.time > cutoff);

  if (rawPressure !== null)  history.pressure.push({ time: now, value: inHgToHPa(rawPressure) });
  if (rawTemp     !== null)  history.temperature.push({ time: now, value: fToC(rawTemp)       });
  if (rawDewPoint !== null)  history.dewPoint.push({ time: now, value: fToC(rawDewPoint)      });

  // Write back with 49h TTL so KV auto-cleans if station goes offline
  try {
    await kv.put(KV_HISTORY_KEY, JSON.stringify(history), { expirationTtl: 49 * 3600 });
  } catch (_) { /* KV write failed — return what we have */ }

  return history;
}

const fToC      = (f)    => (f - 32) * 5 / 9;
const inHgToHPa = (inHg) => inHg * 33.8639;

function parseEcowittValue(obj) {
  if (obj == null || obj.value == null || obj.value === '') return null;
  const n = parseFloat(obj.value);
  return isNaN(n) ? null : n;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}
