// === Wikipedia polling data fetcher + parser ===

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const PAGE_TITLE = 'Opinion_polling_for_the_2026_Hungarian_parliamentary_election';

// Column mapping for the main polling table (2026 election period)
const PARTY_COLUMNS = ['fidesz', 'tisza', 'dk', 'miHazank', 'mkkp', 'others'];

/**
 * Fetch and parse the latest polling data from Wikipedia.
 * Uses the MediaWiki API with origin=* for CORS support.
 *
 * @returns {Promise<Array<{date: string, firm: string, sampleSize: number, fidesz: number, tisza: number, dk: number, miHazank: number, mkkp: number, others: number}>>}
 */
export async function fetchPollingData() {
    // Fetch the wikitext of the page
    const url = new URL(WIKI_API);
    url.searchParams.set('action', 'parse');
    url.searchParams.set('page', PAGE_TITLE);
    url.searchParams.set('prop', 'wikitext');
    url.searchParams.set('format', 'json');
    url.searchParams.set('origin', '*');

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Wikipedia API error: ${resp.status}`);
    const json = await resp.json();

    const wikitext = json.parse?.wikitext?.['*'];
    if (!wikitext) throw new Error('No wikitext returned');

    return parsePollingWikitext(wikitext);
}

/**
 * Parse the wikitext to extract polling tables.
 */
function parsePollingWikitext(wikitext) {
    const polls = [];

    // Find the "Polling" section for the 2026 election period
    // The table starts with {| class="wikitable" and ends with |}
    const tables = extractWikitables(wikitext);

    // The main polling table is typically the 2nd or 3rd table
    // We look for tables that have the expected column structure
    for (const table of tables) {
        const rows = parseTableRows(table);
        for (const row of rows) {
            if (row && row.fidesz != null && row.tisza != null) {
                polls.push(row);
            }
        }
    }

    return polls;
}

/**
 * Extract wikitable blocks from wikitext.
 */
function extractWikitables(wikitext) {
    const tables = [];
    const regex = /\{\|[^\n]*wikitable[^\n]*\n([\s\S]*?)\n\|\}/g;
    let match;
    while ((match = regex.exec(wikitext)) !== null) {
        tables.push(match[1]);
    }
    return tables;
}

/**
 * Parse rows from a wikitable body.
 */
function parseTableRows(tableBody) {
    const rows = tableBody.split('\n|-');
    const results = [];

    for (const row of rows) {
        const cells = row.split('\n|').slice(1); // Skip first empty part
        if (cells.length < 8) continue; // Need at least date, firm, sample + 5 party columns

        const parsed = parsePollingRow(cells);
        if (parsed) results.push(parsed);
    }

    return results;
}

/**
 * Parse a single polling data row.
 */
function parsePollingRow(cells) {
    try {
        // Clean cells: remove style attributes, wiki markup, links
        const clean = cells.map(c => cleanWikiCell(c));

        // Detect if this is a data row (first cell should be a date)
        if (!isDateLike(clean[0])) return null;

        // The structure varies slightly between tables, but generally:
        // [date, firm, (affiliation?), (sample?), fidesz, tisza, dk, miHazank, mkkp, others, lead]
        // We need to detect which column is which by counting numeric values

        let dateIdx = 0;
        let firmIdx = 1;
        let firstPartyIdx = -1;

        // Find the first cell that looks like a percentage (the first party column)
        for (let i = 2; i < clean.length; i++) {
            const val = parseNumber(clean[i]);
            if (val !== null && val >= 0 && val <= 100) {
                firstPartyIdx = i;
                break;
            }
        }

        if (firstPartyIdx < 0) return null;

        const sampleIdx = firstPartyIdx - 1;
        const sampleSize = parseNumber(clean[sampleIdx]) || 1000;

        // Party values starting from firstPartyIdx
        const fidesz = parseNumber(clean[firstPartyIdx]) || 0;
        const tisza = parseNumber(clean[firstPartyIdx + 1]) || 0;
        const dk = parseNumber(clean[firstPartyIdx + 2]) || 0;
        const miHazank = parseNumber(clean[firstPartyIdx + 3]) || 0;
        const mkkp = parseNumber(clean[firstPartyIdx + 4]) || 0;
        const others = parseNumber(clean[firstPartyIdx + 5]) || 0;

        // Sanity check: values should be reasonable
        if (fidesz === 0 && tisza === 0) return null;
        if (fidesz > 80 || tisza > 80) return null;

        return {
            date: clean[dateIdx],
            firm: clean[firmIdx],
            sampleSize,
            fidesz,
            tisza,
            dk,
            miHazank,
            mkkp,
            others,
        };
    } catch (e) {
        return null;
    }
}

/**
 * Clean a wiki table cell: remove markup, styles, links.
 */
function cleanWikiCell(cell) {
    let s = cell.trim();
    // Remove style attributes: style="..." |
    s = s.replace(/style="[^"]*"\s*\|/g, '');
    // Remove bold/italic
    s = s.replace(/'{2,3}/g, '');
    // Remove wiki links: [[...|text]] -> text, or [[text]] -> text
    s = s.replace(/\[\[[^\]]*\|([^\]]*)\]\]/g, '$1');
    s = s.replace(/\[\[([^\]]*)\]\]/g, '$1');
    // Remove external links: [url text] -> text
    s = s.replace(/\[[^\s\]]+ ([^\]]*)\]/g, '$1');
    s = s.replace(/\[[^\]]*\]/g, '');
    // Remove HTML tags
    s = s.replace(/<[^>]*>/g, '');
    // Remove ref tags
    s = s.replace(/\{\{[^}]*\}\}/g, '');
    return s.trim();
}

function isDateLike(s) {
    // Matches patterns like "16–17 Mar 2026", "Mar 2026", "2026-03-17"
    return /\d{4}|[A-Z][a-z]{2}\s+\d{4}|\d{1,2}[\s–-]+\d{1,2}/.test(s);
}

function parseNumber(s) {
    if (!s) return null;
    s = s.replace(/,/g, '').replace(/\s/g, '').replace(/–/g, '').replace(/−/g, '');
    if (s === '' || s === '–' || s === '−' || s === '-') return null;
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
}

/**
 * Polling firm bias classification.
 * "gov" = government-aligned, "opp" = opposition-aligned / independent.
 * Firms not listed default to "opp" (independent).
 */
const FIRM_BIAS = {
    'századvég':    'gov',
    'szazadveg':    'gov',
    'nézőpont':     'gov',
    'nezopont':     'gov',
    'nézopont':     'gov',
    'iránytű':      'gov',
    'iranytű':      'gov',
    'iranytu':      'gov',
    'real':         'gov',
    'real-pr':      'gov',
    'medián':       'opp',
    'median':       'opp',
    'publicus':     'opp',
    'závecz':       'opp',
    'zavecz':       'opp',
    'republikon':   'opp',
    'idea':         'opp',
    'ipsos':        'opp',
};

/**
 * Classify a polling firm name as "gov" or "opp".
 */
function classifyFirm(firmName) {
    const lower = (firmName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const lowerOrig = (firmName || '').toLowerCase();
    for (const [key, bias] of Object.entries(FIRM_BIAS)) {
        if (lowerOrig.includes(key) || lower.includes(key)) return bias;
    }
    return 'opp'; // default: independent
}

/**
 * Filter polls by firm bias.
 * @param {Array} polls
 * @param {"all"|"gov"|"opp"} filter
 * @returns {Array}
 */
export function filterPollsByBias(polls, filter = 'all') {
    if (filter === 'all') return polls;
    return polls.filter(p => classifyFirm(p.firm) === filter);
}

/**
 * Average the most recent N polls.
 *
 * @param {Array} polls - parsed polling data
 * @param {number} count - how many recent polls to average
 * @returns {{fidesz: number, tisza: number, dk: number, miHazank: number, mkkp: number, others: number}}
 */
export function averageRecentPolls(polls, count = 5) {
    const recent = polls.slice(0, count);
    if (recent.length === 0) return null;

    const avg = { fidesz: 0, tisza: 0, dk: 0, miHazank: 0, mkkp: 0, others: 0 };
    for (const poll of recent) {
        for (const key of PARTY_COLUMNS) {
            avg[key] += poll[key] || 0;
        }
    }
    for (const key of PARTY_COLUMNS) {
        avg[key] /= recent.length;
    }
    return avg;
}
