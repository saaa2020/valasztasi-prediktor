// === Live data layer: turnout, events, results ===
// Election day fetching from vtr.valasztas.hu
//
// URL structure (discovered from vtr SPA bundle):
//   /{ver}/ver/{file}        - static base data (parties, OEVKs, etc.)
//   /{napkozi}/napkozi/{file} - daytime turnout (only when config.napkozi != null)
//   /{szavossz}/szavossz/{file} - vote results (only when config.szavossz != null)
//   Rkesem.json (extraordinary events) is fetched from BOTH napkozi and szavossz buckets
//
// The {napkozi} and {szavossz} version strings come from config.json and act as
// natural cache-busters: when content updates, the version changes.

import { bus } from './utils.js?v=11';

const API_BASE = 'https://vtr.valasztas.hu/ogy2026/data';
// CORS proxies in priority order. codetabs verified working 2026-04-11; others as fallback.
// IMPORTANT: vtr.valasztas.hu does NOT send CORS headers, so a proxy is mandatory.
// If codetabs goes down on election day, the fallbacks should kick in automatically.
const CORS_PROXIES = [
    'https://api.codetabs.com/v1/proxy/?quest=',
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?',
];

// localStorage key prefix and quota guard
const LS_PREFIX = 'vp_live_';
const LS_HISTORY_MAX = 200; // max snapshots per key

// ===== Low-level fetch =====

/**
 * Fetch a JSON resource from vtr via CORS proxy with fallback.
 * Adds a cache-busting query param so proxies do not serve stale data.
 */
async function fetchJson(path, { timeoutMs = 15000 } = {}) {
    const cacheBust = `_=${Date.now()}`;
    const sep = path.includes('?') ? '&' : '?';
    const upstream = `${API_BASE}${path}${sep}${cacheBust}`;

    let lastError = null;
    for (const proxy of CORS_PROXIES) {
        const url = `${proxy}${encodeURIComponent(upstream)}`;
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            const resp = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
            clearTimeout(timer);

            if (resp.status === 404) {
                // Hard 404 from proxy: file does not exist - treat as "not yet available"
                return null;
            }
            if (resp.status >= 500 || resp.status === 429) {
                // Proxy/upstream server error - try next proxy
                lastError = new Error(`HTTP ${resp.status} for ${path}`);
                continue;
            }
            if (!resp.ok) {
                lastError = new Error(`HTTP ${resp.status} for ${path}`);
                continue;
            }
            const text = await resp.text();
            if (!text || text.trim() === '') return null;

            // Soft-404: vtr S3 returns 200 + SPA index.html when file is missing.
            // Treat any HTML body as "not yet available" rather than as a proxy fault,
            // because retrying through another proxy would just yield the same HTML.
            const trimmed = text.trimStart();
            if (trimmed.startsWith('<')) {
                return null;
            }

            try {
                return JSON.parse(text);
            } catch (parseErr) {
                lastError = new Error(`JSON parse failed for ${path}: ${parseErr.message}`);
                continue;
            }
        } catch (err) {
            lastError = err;
            // network error / timeout - try next proxy
        }
    }
    if (lastError) throw lastError;
    return null;
}

// ===== Config polling =====

/**
 * Fetch the top-level config.json which lists current versions for ver/napkozi/szavossz.
 * Schema: { ver: "04112100", napkozi: null|"YYYYMMDDHHmm", szavossz: null|"YYYYMMDDHHmm" }
 */
export async function fetchLiveConfig() {
    return fetchJson('/config.json');
}

// ===== Specific endpoint helpers =====

export async function fetchTurnoutNational(napkoziVer) {
    if (!napkoziVer) return null;
    return fetchJson(`/${napkoziVer}/napkozi/ReszvetelOrszag.json`);
}

export async function fetchTurnoutCounty(napkoziVer) {
    if (!napkoziVer) return null;
    return fetchJson(`/${napkoziVer}/napkozi/ReszvetelMegye.json`);
}

export async function fetchTurnoutOevk(napkoziVer) {
    if (!napkoziVer) return null;
    return fetchJson(`/${napkoziVer}/napkozi/ReszvetelOevk.json`);
}

export async function fetchTurnoutForeign(napkoziVer) {
    if (!napkoziVer) return null;
    return fetchJson(`/${napkoziVer}/napkozi/ReszvetelKulkepv.json`);
}

/**
 * Fetch extraordinary events. The vtr SPA fetches Rkesem.json from whichever
 * source bucket is currently active (napkozi or szavossz).
 */
export async function fetchEvents(version, source) {
    if (!version || !source) return null;
    return fetchJson(`/${version}/${source}/Rkesem.json`);
}

export async function fetchOevkResults(szavosszVer) {
    if (!szavosszVer) return null;
    return fetchJson(`/${szavosszVer}/szavossz/OevkJkv.json`);
}

export async function fetchListResults(szavosszVer) {
    if (!szavosszVer) return null;
    return fetchJson(`/${szavosszVer}/szavossz/ListasJkv.json`);
}

export async function fetchWinners(szavosszVer) {
    if (!szavosszVer) return null;
    return fetchJson(`/${szavosszVer}/szavossz/OevkElsok.json`);
}

export async function fetchHorseshoeData(szavosszVer) {
    if (!szavosszVer) return null;
    return fetchJson(`/${szavosszVer}/szavossz/Patko.json`);
}

export async function fetchOrgResults(szavosszVer) {
    if (!szavosszVer) return null;
    return fetchJson(`/${szavosszVer}/szavossz/SzervezetekEredmenye.json`);
}

export async function fetchCloseRaces(szavosszVer) {
    if (!szavosszVer) return null;
    return fetchJson(`/${szavosszVer}/szavossz/SzorosVerseny.json`);
}

// ===== History store (localStorage, time-series) =====

/**
 * Append a snapshot to a named history key.
 * Each entry: { ts: epochMs, ver: versionString, data: payload }
 * Trims history to LS_HISTORY_MAX entries (drops oldest).
 */
export function appendHistory(key, ver, payload) {
    const lsKey = LS_PREFIX + key;
    let arr = [];
    try {
        const stored = localStorage.getItem(lsKey);
        if (stored) arr = JSON.parse(stored);
    } catch (e) {
        arr = [];
    }
    // Skip if same version already at the tail
    if (arr.length && arr[arr.length - 1].ver === ver) {
        return false;
    }
    arr.push({ ts: Date.now(), ver, data: payload });
    if (arr.length > LS_HISTORY_MAX) {
        arr = arr.slice(-LS_HISTORY_MAX);
    }
    try {
        localStorage.setItem(lsKey, JSON.stringify(arr));
    } catch (e) {
        // Quota exceeded - keep last 50 only and retry once
        try {
            arr = arr.slice(-50);
            localStorage.setItem(lsKey, JSON.stringify(arr));
        } catch (e2) {
            console.warn('localStorage write failed for', key, e2);
            return false;
        }
    }
    return true;
}

export function getHistory(key) {
    const lsKey = LS_PREFIX + key;
    try {
        const stored = localStorage.getItem(lsKey);
        if (stored) return JSON.parse(stored);
    } catch (e) { /* ignore */ }
    return [];
}

export function getLatest(key) {
    const arr = getHistory(key);
    return arr.length ? arr[arr.length - 1] : null;
}

export function clearHistory(key) {
    if (key) {
        localStorage.removeItem(LS_PREFIX + key);
    } else {
        // Clear all live history
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(LS_PREFIX)) toRemove.push(k);
        }
        toRemove.forEach(k => localStorage.removeItem(k));
    }
}

// ===== Polling controller =====

/**
 * LivePoller orchestrates the time-based fetch schedule.
 *
 * Schedule (Hungarian local time):
 *   - Always: poll config.json every CONFIG_INTERVAL (60s)
 *   - When config.napkozi is set: fetch turnout endpoints (rate-limited by version change)
 *   - When config.szavossz is set: fetch result endpoints every RESULT_INTERVAL (10 min)
 *   - Events (Rkesem.json): polled with config (cheap, small file)
 *
 * Version-change detection: if the version string did not change, the data is
 * the same - we skip the network call and only emit a status event. This means
 * we can poll aggressively without wasting bandwidth.
 */
const CONFIG_INTERVAL_MS = 60 * 1000;        // 1 minute
const TURNOUT_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes - vtr only refreshes turnout half-hourly
const RESULT_INTERVAL_MS = 2 * 60 * 1000;    // 2 minutes - election night needs frequent updates

export class LivePoller {
    constructor() {
        this.config = null;
        this.lastConfigFetchTs = 0;
        this.lastTurnoutFetchTs = 0;
        this.lastResultFetchTs = 0;
        this.timer = null;
        this.enabled = false;
        this.lastError = null;
        this.fetchInFlight = false;
    }

    /** Current source bucket: 'szavossz' takes precedence over 'napkozi' */
    getActiveSource() {
        if (this.config?.szavossz) return 'szavossz';
        if (this.config?.napkozi) return 'napkozi';
        return null;
    }

    getActiveVersion() {
        const src = this.getActiveSource();
        if (!src) return null;
        return this.config[src];
    }

    /** Start the auto-poll loop. */
    start() {
        if (this.enabled) return;
        this.enabled = true;
        this._tick(); // immediate first run
        this.timer = setInterval(() => this._tick(), CONFIG_INTERVAL_MS);
        bus.emit('live-poll-state', { enabled: true });
    }

    stop() {
        if (!this.enabled) return;
        this.enabled = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        bus.emit('live-poll-state', { enabled: false });
    }

    /** Manually trigger a full fetch cycle. */
    async pollNow() {
        await this._tick(true);
    }

    async _tick(force = false) {
        if (this.fetchInFlight) return;
        this.fetchInFlight = true;
        try {
            const prevNapkozi = this.config?.napkozi;
            const prevSzavossz = this.config?.szavossz;
            await this._fetchConfig();
            const src = this.getActiveSource();
            const ver = this.getActiveVersion();

            // Version changed = new data available, treat as forced
            const napkoziChanged = this.config?.napkozi && this.config.napkozi !== prevNapkozi;
            const szavosszChanged = this.config?.szavossz && this.config.szavossz !== prevSzavossz;

            // Always try to fetch events when there is an active source
            if (src && ver) {
                await this._fetchEvents(ver, src);
            }

            // Turnout: poll while napkozi is active (even during szavossz, for gap-filling)
            if (this.config?.napkozi) {
                const due = force || napkoziChanged || (Date.now() - this.lastTurnoutFetchTs >= TURNOUT_INTERVAL_MS);
                if (due) {
                    await this._fetchTurnout(this.config.napkozi);
                }
            }

            // Results: poll once szavossz is set
            if (this.config?.szavossz) {
                const due = force || szavosszChanged || (Date.now() - this.lastResultFetchTs >= RESULT_INTERVAL_MS);
                if (due) {
                    await this._fetchResults(this.config.szavossz);
                }
            }
            this.lastError = null;
        } catch (err) {
            this.lastError = err.message || String(err);
            console.error('LivePoller tick error:', err);
            bus.emit('live-error', { error: this.lastError });
        } finally {
            this.fetchInFlight = false;
        }
    }

    async _fetchConfig() {
        const cfg = await fetchLiveConfig();
        this.lastConfigFetchTs = Date.now();
        const prev = this.config;
        this.config = cfg;
        const changed = !prev
            || prev.ver !== cfg?.ver
            || prev.napkozi !== cfg?.napkozi
            || prev.szavossz !== cfg?.szavossz;
        bus.emit('live-config', { config: cfg, changed });
        return cfg;
    }

    async _fetchTurnout(napkoziVer) {
        // Fetch all four turnout files in parallel
        const [national, county, oevk, foreign] = await Promise.all([
            fetchTurnoutNational(napkoziVer).catch(e => { console.warn('national turnout', e); return null; }),
            fetchTurnoutCounty(napkoziVer).catch(e => { console.warn('county turnout', e); return null; }),
            fetchTurnoutOevk(napkoziVer).catch(e => { console.warn('oevk turnout', e); return null; }),
            fetchTurnoutForeign(napkoziVer).catch(e => { console.warn('foreign turnout', e); return null; }),
        ]);
        this.lastTurnoutFetchTs = Date.now();

        if (national) appendHistory('turnout_national', napkoziVer, national);
        if (county) appendHistory('turnout_county', napkoziVer, county);
        if (oevk) appendHistory('turnout_oevk', napkoziVer, oevk);
        if (foreign) appendHistory('turnout_foreign', napkoziVer, foreign);

        bus.emit('live-turnout', {
            ver: napkoziVer,
            national, county, oevk, foreign,
        });
    }

    async _fetchEvents(version, source) {
        try {
            const events = await fetchEvents(version, source);
            if (events) {
                appendHistory(`events_${source}`, version, events);
                bus.emit('live-events', { ver: version, source, events });
            }
        } catch (e) {
            console.warn('events fetch', e);
        }
    }

    async _fetchResults(szavosszVer) {
        const [oevkRes, listRes, winners, horseshoe, orgRes, closeRaces] = await Promise.all([
            fetchOevkResults(szavosszVer).catch(e => { console.warn('oevk results', e); return null; }),
            fetchListResults(szavosszVer).catch(e => { console.warn('list results', e); return null; }),
            fetchWinners(szavosszVer).catch(e => { console.warn('winners', e); return null; }),
            fetchHorseshoeData(szavosszVer).catch(e => { console.warn('horseshoe', e); return null; }),
            fetchOrgResults(szavosszVer).catch(e => { console.warn('org results', e); return null; }),
            fetchCloseRaces(szavosszVer).catch(e => { console.warn('close races', e); return null; }),
        ]);
        this.lastResultFetchTs = Date.now();

        if (oevkRes) appendHistory('results_oevk', szavosszVer, oevkRes);
        if (listRes) appendHistory('results_list', szavosszVer, listRes);
        if (winners) appendHistory('results_winners', szavosszVer, winners);
        if (horseshoe) appendHistory('results_horseshoe', szavosszVer, horseshoe);
        if (orgRes) appendHistory('results_org', szavosszVer, orgRes);
        if (closeRaces) appendHistory('results_close', szavosszVer, closeRaces);

        bus.emit('live-results', {
            ver: szavosszVer,
            oevkRes, listRes, winners, horseshoe, orgRes, closeRaces,
        });
    }

    /** Snapshot of current state for UI status display */
    getStatus() {
        return {
            enabled: this.enabled,
            config: this.config,
            source: this.getActiveSource(),
            version: this.getActiveVersion(),
            lastConfigFetchTs: this.lastConfigFetchTs,
            lastTurnoutFetchTs: this.lastTurnoutFetchTs,
            lastResultFetchTs: this.lastResultFetchTs,
            lastError: this.lastError,
            fetchInFlight: this.fetchInFlight,
        };
    }
}

// Singleton
export const livePoller = new LivePoller();
