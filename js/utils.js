// === Utility functions ===

export function formatNumber(n) {
    if (n == null) return '–';
    return n.toLocaleString('hu-HU');
}

export function formatPct(n, decimals = 1) {
    if (n == null) return '–';
    return n.toFixed(decimals) + '%';
}

export function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

/** Lighten a hex color by a given amount (0-1) */
export function lightenColor(hex, amount = 0.3) {
    hex = hex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const nr = Math.round(r + (255 - r) * amount);
    const ng = Math.round(g + (255 - g) * amount);
    const nb = Math.round(b + (255 - b) * amount);
    return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
}

/** Build OEVK id from county code + constituency number */
export function oevkId(maz, evk) {
    return `${String(maz).padStart(2, '0')}-${String(evk).padStart(2, '0')}`;
}

/** Parse OEVK id to { maz, evk } */
export function parseOevkId(id) {
    const [maz, evk] = id.split('-');
    return { maz, evk };
}

/** Debounce a function call */
export function debounce(fn, ms = 150) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

/** Simple event emitter for reactive updates */
export class EventBus {
    constructor() {
        this._listeners = {};
    }

    on(event, fn) {
        (this._listeners[event] ||= []).push(fn);
        return () => this.off(event, fn);
    }

    off(event, fn) {
        const list = this._listeners[event];
        if (list) this._listeners[event] = list.filter(f => f !== fn);
    }

    emit(event, data) {
        (this._listeners[event] || []).forEach(fn => fn(data));
    }
}

export const bus = new EventBus();

// Real party colors (API colors are wrong for many parties)
export const PARTY_COLOR_OVERRIDES = {
    // Major parties
    'FIDESZ':       '#F58220',  // Fidesz orange
    'FIDESZ-KDNP':  '#F58220',  // Fidesz-KDNP orange
    'KDNP':         '#F5A623',  // KDNP gold-orange
    'TISZA':        '#1DA1C7',  // TISZA blue
    // Minor parties
    'DK':           '#1D4F91',  // DK blue
    'Mi Hazánk':    '#6B8E23',  // Mi Hazánk olive green
    'MKKP':         '#808080',  // MKKP gray
    'MSZP':         '#CE2027',  // MSZP red
    'LMP – Zöldek': '#84B414', // LMP green
    'Jobbik':       '#1B7536',  // Jobbik dark green
    'Munkáspárt':   '#CC0000',  // Munkáspárt red
    'SZOM':         '#E81B85',  // SZOM pink (correct in API)
    'Független':    '#555566',  // Independent dark gray
};

// Party tier classification
export const PARTY_TIERS = {
    MAJOR: ['FIDESZ', 'KDNP', 'FIDESZ-KDNP', 'TISZA'],
    MINOR: ['DK', 'Mi Hazánk', 'MI HAZÁNK'],
    // Everything else is OTHER
};

export function getPartyTier(partyName) {
    const upper = (partyName || '').toUpperCase();
    if (PARTY_TIERS.MAJOR.some(p => upper.includes(p))) return 'MAJOR';
    if (PARTY_TIERS.MINOR.some(p => upper.includes(p))) return 'MINOR';
    return 'OTHER';
}
