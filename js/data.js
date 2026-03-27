// === Data layer: fetch, cache, normalize ===

const API_BASE = 'https://vtr.valasztas.hu/ogy2026/data';
const IMAGE_URL = 'https://vtr.valasztas.hu/ogy2026/kepek';
const LOCAL_BASE = './data/cache';

// CORS proxy for production (browser-only, won't work from server-side)
const CORS_PROXY = 'https://corsproxy.io/?';

let _version = null;
let _versionPromise = null;
let _cache = {};
let _useLocal = false;

/** Fetch config.json to get current data version (deduplicated) */
async function fetchVersion() {
    if (_version) return _version;
    if (_versionPromise) return _versionPromise;

    _versionPromise = (async () => {
        // Try local first
        try {
            const resp = await fetch(`${LOCAL_BASE}/config.json`);
            if (resp.ok) {
                const config = await resp.json();
                _version = config.ver;
                _useLocal = true;
                console.log(`Using local data cache (version: ${_version})`);
                return _version;
            }
        } catch (e) { /* fall through */ }

        // Try CORS proxy
        try {
            const resp = await fetch(`${CORS_PROXY}${encodeURIComponent(`${API_BASE}/config.json`)}`);
            if (resp.ok) {
                const config = await resp.json();
                _version = config.ver;
                console.log(`Using API via CORS proxy (version: ${_version})`);
                return _version;
            }
        } catch (e) { /* fall through */ }

        throw new Error('Nem sikerült az adatforráshoz csatlakozni. Ellenőrizd az internetkapcsolatot.');
    })();

    return _versionPromise;
}

/** Fetch a JSON data file with caching */
async function fetchData(filename) {
    if (_cache[filename]) return _cache[filename];

    const ver = await fetchVersion();

    // Check sessionStorage
    const storageKey = `vp_${ver}_${filename}`;
    try {
        const stored = sessionStorage.getItem(storageKey);
        if (stored) {
            const parsed = JSON.parse(stored);
            _cache[filename] = parsed;
            return parsed;
        }
    } catch (e) { /* ignore */ }

    let data;
    if (_useLocal) {
        const resp = await fetch(`${LOCAL_BASE}/${filename}`);
        if (!resp.ok) throw new Error(`Failed to fetch local ${filename}: ${resp.status}`);
        data = await resp.json();
    } else {
        const url = `${CORS_PROXY}${encodeURIComponent(`${API_BASE}/${ver}/ver/${filename}`)}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to fetch ${filename}: ${resp.status}`);
        data = await resp.json();
    }

    _cache[filename] = data;
    try {
        sessionStorage.setItem(storageKey, JSON.stringify(data));
    } catch (e) { /* sessionStorage might be full */ }

    return data;
}

/** Get image URL for a candidate photo or party emblem */
export function getImageUrl(id) {
    if (!id) return null;
    // Images need CORS proxy too, or direct URL (works in <img> tags)
    return `${IMAGE_URL}/${id}`;
}

import { PARTY_COLOR_OVERRIDES } from './utils.js?v=4';

// === Normalized data accessors ===

/** Fetch and normalize all parties/organizations */
export async function fetchParties() {
    const raw = await fetchData('Szervezetek.json');
    const list = raw.list || raw;
    return list.map(p => ({
        code: p.szkod,
        name: p.nev,
        shortName: p.r_nev,
        emblemId: p.emblema,
        coalitionCodes: p.jelolo_csoportok || [],
        isNationality: p.nemzetisegi === 'I',
    }));
}

/** Fetch and normalize nominating groups / coalitions (jelölőcsoportok) */
export async function fetchCoalitions() {
    const raw = await fetchData('Jlcs.json');
    const list = raw.list || raw;
    return list.map(j => {
        const name = j.nev;
        // Apply realistic color overrides
        const overrideColor = PARTY_COLOR_OVERRIDES[name];
        return {
            code: j.kod,
            name,
            shortName: name,
            color: overrideColor || j.color || '#888888',
            memberCount: j.tag || 1,
            orgCodes: j.szervezet_lst || [],
        };
    });
}

/** Fetch all 106 OEVKs */
export async function fetchOevks() {
    const raw = await fetchData('OevkAdatok.json');
    const list = raw.list || raw;
    return list.map(o => ({
        id: `${String(o.maz).padStart(2, '0')}-${String(o.evk).padStart(2, '0')}`,
        maz: String(o.maz).padStart(2, '0'),
        evk: String(o.evk).padStart(2, '0'),
        name: o.evk_nev,
        szekhely: o.szekhely || '',
        county: o.maz_nev,
        voters: o.letszam ? o.letszam.osszesen : 0,
        votersResident: o.letszam ? o.letszam.honos : 0,
        votersTransferred: o.letszam ? o.letszam.atjel : 0,
        votersForeign: o.letszam ? o.letszam.kuvi : 0,
        canVote: o.oevk_jeloltre_szavhat || 0,
    }));
}

/** Fetch OEVK polygons for map rendering */
export async function fetchOevkPolygons() {
    const raw = await fetchData('OevkPoligonok.json');
    const list = raw.list || raw;
    return list.map(p => ({
        id: `${String(p.maz).padStart(2, '0')}-${String(p.evk).padStart(2, '0')}`,
        polygon: parsePolygonString(p.poligon),
        center: parseCenterString(p.centrum),
    }));
}

/** Fetch county polygons for map borders */
export async function fetchCountyPolygons() {
    const raw = await fetchData('Megyek.json');
    const list = raw.list || raw;
    return list.map(m => {
        const desc = m.leiro || m;
        return {
            code: String(desc.maz).padStart(2, '0'),
            name: desc.nevi || desc.nev,
            polygon: parsePolygonString(desc.megye_poligon || desc.poligon),
            center: parseCenterString(desc.centrum),
        };
    });
}

/** Fetch all individual candidates (only registered: allapot="1") */
export async function fetchCandidates() {
    const raw = await fetchData('EgyeniJeloltek.json');
    const list = raw.list || raw;
    return list.filter(c => c.allapot === '1').map(c => ({
        id: c.ej_id,
        name: c.neve,
        maz: String(c.maz).padStart(2, '0'),
        evk: String(c.evk).padStart(2, '0'),
        oevkId: `${String(c.maz).padStart(2, '0')}-${String(c.evk).padStart(2, '0')}`,
        coalitionCode: c.jlcs_kod,
        coalitionName: c.jlcs_nev,
        orgCodes: c.jelolo_szervezetek || [],
        photoId: c.fenykep,
        listMemberships: c.listak || [],
        ballotOrder: c.szavlap_sorsz,
    }));
}

/** Fetch party lists and their candidates (only registered lists: allapot="1") */
export async function fetchPartyLists() {
    const raw = await fetchData('ListakEsJeloltek.json');
    const list = raw.list || raw;
    return list
        .filter(l => l.allapot === '1') // Only registered lists
        .map(l => ({
            listId: l.tl_id,
            coalitionCode: l.jlcs_kod,
            type: l.lista_tip, // "O" = ordinary, "K" = coalition, "N" = nationality
            threshold: parseInt(l.hatar || '5', 10),
            coalitionName: l.jlcs_nev,
            nemzkod: l.nemzkod || null, // Nationality code (only for type "N")
            candidates: (l.jeloltek || [])
                .filter(j => j.allapot === '1') // Only registered candidates
                .map(j => ({
                    id: j.tj_id,
                    name: j.neve,
                    position: j.sorsz,
                })),
        }));
}

/** Fetch 2022 OEVK results - flat list, needs grouping */
export async function fetchPrevResults() {
    const raw = await fetchData('ElozoOevkEredmenyek.json');
    const list = raw.list || raw;

    // Group by OEVK id
    const grouped = new Map();
    for (const r of list) {
        const id = `${String(r.maz).padStart(2, '0')}-${String(r.evk).padStart(2, '0')}`;
        if (!grouped.has(id)) grouped.set(id, []);
        grouped.get(id).push({
            name: r.neve,
            coalition: r.jlcs_nev,
            votes: r.szavazat || 0,
            pct: r.szavazat_szaz || 0,
        });
    }

    return [...grouped.entries()].map(([id, results]) => ({
        id,
        results: results.sort((a, b) => b.votes - a.votes),
    }));
}

// Mapping from NVI nationality code (nemzkod) to OsszLetszam.json field name
const NEMZKOD_TO_FIELD = {
    1: 'bolgar', 2: 'gorog', 3: 'horvat', 4: 'lengyel', 5: 'nemet',
    6: 'ormeny', 7: 'roma', 8: 'roman', 9: 'ruszin', 10: 'szerb',
    11: 'szlovak', 12: 'szloven', 13: 'ukran',
};

/** Fetch national voter totals (including nationality voter counts) */
export async function fetchNationalTotals() {
    const raw = await fetchData('OsszLetszam.json');
    const d = raw.data || raw;

    // Extract nationality voter counts: nemzkod -> registered voters
    const nationalityVoters = {};
    for (const [nemzkod, field] of Object.entries(NEMZKOD_TO_FIELD)) {
        nationalityVoters[nemzkod] = d[field] || 0;
    }

    return {
        totalVoters: d.szumma || 0,
        domesticVoters: d.magyarLakc || d.lakcSzavkorSzavaz || 0,
        postalVoters: d.levelben || 0,
        partyListVoters: d.partlistara || 0,
        nationalityVoters,
    };
}

// === Polygon parsing helpers ===

function parsePolygonString(str) {
    if (!str) return [];
    return str.split(',').map(pair => {
        const [lat, lon] = pair.trim().split(/\s+/).map(Number);
        return [lat, lon];
    }).filter(p => !isNaN(p[0]) && !isNaN(p[1]));
}

function parseCenterString(str) {
    if (!str) return null;
    const parts = str.trim().split(/\s+/).map(Number);
    if (parts.length >= 2) return [parts[0], parts[1]];
    return null;
}

// === Load all data at once ===

export async function loadAllData(onProgress) {
    const steps = [
        ['parties', fetchParties],
        ['coalitions', fetchCoalitions],
        ['oevks', fetchOevks],
        ['oevkPolygons', fetchOevkPolygons],
        ['countyPolygons', fetchCountyPolygons],
        ['candidates', fetchCandidates],
        ['partyLists', fetchPartyLists],
        ['prevResults', fetchPrevResults],
        ['nationalTotals', fetchNationalTotals],
    ];

    const result = {};
    let done = 0;

    const promises = steps.map(async ([key, fn]) => {
        result[key] = await fn();
        done++;
        if (onProgress) onProgress(done, steps.length, key);
    });

    await Promise.all(promises);

    // Build lookup maps
    result.coalitionMap = new Map(result.coalitions.map(c => [c.code, c]));
    result.oevkMap = new Map(result.oevks.map(o => [o.id, o]));
    result.candidatesByOevk = new Map();
    for (const c of result.candidates) {
        if (!result.candidatesByOevk.has(c.oevkId)) {
            result.candidatesByOevk.set(c.oevkId, []);
        }
        result.candidatesByOevk.get(c.oevkId).push(c);
    }
    result.prevResultsMap = new Map(result.prevResults.map(r => [r.id, r]));
    result.polygonMap = new Map(result.oevkPolygons.map(p => [p.id, p]));

    // Build party list map by coalition code (excluding nationality lists)
    result.partyListMap = new Map();
    for (const l of result.partyLists) {
        if (l.type !== 'N') {
            result.partyListMap.set(l.coalitionCode, l);
        }
    }

    // Build nationality list map: coalitionCode -> { ...listInfo, registeredVoters }
    result.nationalityListMap = new Map();
    for (const l of result.partyLists) {
        if (l.type === 'N' && l.nemzkod != null) {
            const registeredVoters = result.nationalTotals.nationalityVoters[l.nemzkod] || 0;
            result.nationalityListMap.set(l.coalitionCode, {
                ...l,
                registeredVoters,
            });
        }
    }

    return result;
}
