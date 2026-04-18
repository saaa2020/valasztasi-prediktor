// === Main application entry point ===

import { loadAllData } from './data.js?v=11';
import { renderMap, updateAllColors, showTooltip } from './map.js?v=11';
import { renderHorseshoe } from './horseshoe.js?v=11';
import { calculateSeatAllocation } from './electoral-math.js?v=11';
import { PredictionState } from './prediction.js?v=11';
import { fetchPollingData, averageRecentPolls, filterPollsByBias } from './polling.js?v=11';
import { bus, formatNumber, formatPct, debounce, getPartyTier } from './utils.js?v=11';
import { livePoller, getLatest } from './live.js?v=11';

let data = null;
let state = null;
let currentAllocation = null;
let selectedOevkId = null;
let activeListTab = 'domestic';

// Live mode state
let liveMode = false;
let liveView = 'prediction'; // 'prediction' | 'turnout' | 'winners'
let liveData = {
    config: null,
    turnout: null,    // { national, county, oevk, foreign, ver }
    events: null,     // { events, ver, source }
    results: null,    // { oevkRes, listRes, winners, horseshoe, orgRes, closeRaces, ver }
};

// === Initialization ===

async function init() {
    const loadingEl = document.getElementById('loading-indicator');
    loadingEl.classList.remove('hidden');

    try {
        data = await loadAllData((done, total, key) => {
            loadingEl.textContent = `Betöltés... (${done}/${total})`;
        });

        state = new PredictionState(data);

        // Render initial UI
        renderMapView();
        setupControlPanel(); // One-time event listener setup
        renderControlPanel(); // Initial value render
        recalculate();

        // Event listeners
        setupEventListeners();

        // Enable header buttons
        document.getElementById('btn-auto-fill').disabled = false;
        document.getElementById('btn-reset').disabled = false;
        loadingEl.classList.add('hidden');

    } catch (err) {
        loadingEl.textContent = `Hiba: ${err.message}`;
        loadingEl.style.color = '#ff4444';
        console.error('Initialization error:', err);
    }
}

// === Map ===

function renderMapView() {
    const getColor = (oevkId) => {
        if (!currentAllocation) return '#444';
        const winnerCode = currentAllocation.oevkWinnerByDistrict.get(oevkId);
        if (winnerCode == null) return '#444';
        const coalition = data.coalitionMap.get(winnerCode);
        return coalition ? coalition.color : '#888';
    };

    renderMap(data, getColor, onOevkClick, onOevkHover);
}

function onOevkClick(oevkId) {
    selectedOevkId = oevkId;
    renderOevkDetail(oevkId);
}

function onOevkHover(oevkId, event) {
    if (!oevkId || !event) {
        showTooltip(null, null, '');
        return;
    }
    const html = buildTooltipHtml(oevkId);
    showTooltip(oevkId, event, html);
}

/**
 * Build tooltip HTML based on current mode and active view.
 * - Live mode + Reszvetel tab: turnout %, voted/total
 * - Live mode + Elo gyoztes tab: live winner + %
 * - Otherwise (incl. live mode + Predikcio tab): prediction winner + %
 */
function buildTooltipHtml(oevkId) {
    const oevk = data.oevkMap.get(oevkId);
    const name = oevk ? oevk.name : oevkId;
    const header = `<div class="tt-name">${escapeHtml(name)}</div>`;

    if (liveMode && liveView === 'turnout') {
        const detail = liveData.turnout
            ? extractOevkTurnoutDetail(oevkId, liveData.turnout.oevk)
            : null;
        if (detail && detail.pct != null) {
            const pctStr = detail.pct.toFixed(1) + '%';
            const sub = (detail.voted != null && detail.total != null)
                ? `${formatNumber(detail.voted)} / ${formatNumber(detail.total)}`
                : '';
            return header
                + `<div class="tt-winner">Reszvetel: ${pctStr}</div>`
                + (sub ? `<div class="tt-winner" style="font-size:0.7rem; color:var(--text-muted);">${sub}</div>` : '');
        }
        return header + '<div>Nincs elo reszveteli adat</div>';
    }

    if (liveMode && liveView === 'winners') {
        const winners = extractWinnersMap(liveData.results && liveData.results.winners);
        const code = winners.get(oevkId);
        const feldar = extractOevkFeldar(oevkId, liveData.results && liveData.results.oevkRes);
        const feldarStr = feldar != null
            ? `<div style="font-size:0.7rem; color:var(--text-muted);">Feldolgozottság: ${feldar.toFixed(1)}%</div>`
            : '';
        if (code != null) {
            const coalition = data.coalitionMap.get(code);
            const partyName = coalition ? (coalition.shortName || coalition.name) : '?';
            const liveResults = liveData.results
                ? extractOevkLiveResults(oevkId, liveData.results.oevkRes)
                : null;
            const winnerEntry = liveResults ? liveResults.find(r => r.mandatum > 0) || liveResults[0] : null;
            const pctStr = winnerEntry ? ` - ${winnerEntry.pct.toFixed(1)}%` : '';
            return header + `<div class="tt-winner">${escapeHtml(partyName)}${pctStr}</div>` + feldarStr;
        }
        return header + '<div>Nincs elo gyoztes adat</div>' + feldarStr;
    }

    // Default: prediction view (also used when live mode + Predikcio tab)
    const candidates = state.getOevkResults(oevkId);
    const winner = candidates && candidates.length > 0
        ? [...candidates].sort((a, b) => b.pct - a.pct)[0]
        : null;
    const coalition = winner ? data.coalitionMap.get(winner.coalitionCode) : null;
    if (winner) {
        const partyName = coalition ? (coalition.shortName || coalition.name) : '?';
        return header + `<div class="tt-winner">${escapeHtml(partyName)} - ${winner.pct.toFixed(1)}%</div>`;
    }
    return header + '<div>Nincs adat</div>';
}

// === Control Panel ===

// Flag to prevent circular updates
let _updatingFromTurnout = false;
let _updatingFromListVotes = false;

/** One-time setup of slider and tab event listeners (call once). */
function setupControlPanel() {
    const slider = document.getElementById('turnout-slider');
    const valueEl = document.getElementById('turnout-value');

    // Live display update while dragging
    slider.addEventListener('input', () => {
        valueEl.textContent = formatPct(parseFloat(slider.value));
        document.getElementById('total-voters').textContent =
            formatNumber(Math.round(data.nationalTotals.domesticVoters * parseFloat(slider.value) / 100));
    });

    // Apply turnout change + scale list votes on release
    slider.addEventListener('change', () => {
        const oldTurnout = state.turnoutPct;
        const newTurnout = parseFloat(slider.value);
        if (oldTurnout === newTurnout) return;

        _updatingFromTurnout = true;
        state.setTurnout(newTurnout);

        // Scale list votes proportionally
        if (oldTurnout > 0) {
            const ratio = newTurnout / oldTurnout;
            for (const [code, entry] of state.listVotes) {
                state.listVotes.get(code).domestic = Math.round(entry.domestic * ratio);
                state.listVotes.get(code).postal = Math.round(entry.postal * ratio);
            }
            bus.emit('prediction-changed', { type: 'list' });
        }

        valueEl.textContent = formatPct(state.turnoutPct);
        document.getElementById('total-voters').textContent = formatNumber(state.getTotalVoters());
        renderListVotes();
        _updatingFromTurnout = false;
    });

    // List vote tabs
    const listTabs = document.querySelectorAll('.list-tabs .tab');
    listTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            listTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeListTab = tab.dataset.tab;
            renderListVotes();
        });
    });
}

/** Re-render control panel values (safe to call repeatedly). */
function renderControlPanel() {
    const slider = document.getElementById('turnout-slider');
    const valueEl = document.getElementById('turnout-value');
    slider.value = state.turnoutPct;
    valueEl.textContent = formatPct(state.turnoutPct);
    document.getElementById('total-voters').textContent = formatNumber(state.getTotalVoters());
    renderListVotes();
}

/**
 * Recalculate turnout from the current total list votes.
 */
function updateTurnoutFromListVotes() {
    if (_updatingFromTurnout) return;
    _updatingFromListVotes = true;

    // Sum all domestic list votes
    let totalDomesticListVotes = 0;
    for (const [, entry] of state.listVotes) {
        totalDomesticListVotes += entry.domestic;
    }

    // Turnout = total domestic list votes / domestic voters * 100
    const domesticVoters = data.nationalTotals.domesticVoters;
    if (domesticVoters > 0 && totalDomesticListVotes > 0) {
        const newTurnout = Math.min(100, (totalDomesticListVotes / domesticVoters) * 100);
        state.turnoutPct = newTurnout;

        const slider = document.getElementById('turnout-slider');
        const valueEl = document.getElementById('turnout-value');
        slider.value = newTurnout;
        valueEl.textContent = formatPct(newTurnout);
        document.getElementById('total-voters').textContent = formatNumber(state.getTotalVoters());
    }

    _updatingFromListVotes = false;
}

function renderListVotes() {
    const container = document.getElementById('list-votes-container');
    container.innerHTML = '';

    // Live mode + winners tab: show live list vote data
    if (liveMode && liveView === 'winners' && liveData.results && liveData.results.listRes) {
        renderLiveListVotes(container);
        return;
    }

    // Sort party lists: major parties first, then minor, then others
    const entries = [...state.listVotes.entries()]
        .map(([code, votes]) => {
            const coalition = data.coalitionMap.get(code);
            const name = coalition ? (coalition.shortName || coalition.name) : `#${code}`;
            const tier = getPartyTier(name);
            return { code, votes, coalition, name, tier };
        })
        .sort((a, b) => {
            const tierOrder = { MAJOR: 0, MINOR: 1, OTHER: 2 };
            return (tierOrder[a.tier] || 2) - (tierOrder[b.tier] || 2);
        });

    for (const { code, votes, coalition, name } of entries) {
        const row = document.createElement('div');
        row.className = 'list-vote-row';

        const color = coalition ? coalition.color : '#888';
        const value = activeListTab === 'domestic' ? votes.domestic : votes.postal;

        row.innerHTML = `
            <span class="party-color" style="background:${color}"></span>
            <span class="party-name" title="${name}">${name}</span>
            <input type="number" min="0" step="1000" value="${value}" data-code="${code}" data-type="${activeListTab}">
        `;

        const input = row.querySelector('input');

        // Update on Enter key or blur (tab away)
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commitListVoteInput(input, code);
            }
        });
        input.addEventListener('blur', () => {
            commitListVoteInput(input, code);
        });

        container.appendChild(row);
    }
}

function renderLiveListVotes(container) {
    const listRes = liveData.results.listRes;
    // Find the national-level entry (oszint "5"), not the last element
    // which may be a county-level breakdown (oszint "4")
    const listEntry = listRes.list && listRes.list.length
        ? (listRes.list.find(e => e.oszint === '5' || e.oszint === 5) || listRes.list[0])
        : null;
    if (!listEntry || !listEntry.tetelek) return;

    // Build tl_id -> { coalitionCode, type } lookup
    const tlIdToInfo = new Map();
    if (data.partyLists) {
        for (const l of data.partyLists) {
            if (l.listId != null) {
                tlIdToInfo.set(l.listId, { coalitionCode: l.coalitionCode, type: l.type });
            }
        }
    }

    // Only show party lists (not nationality lists) — matching vtr website behavior
    // Nationality list entries have osszes_szavazat_nemzlistas_szaz instead of partlistas
    const entries = listEntry.tetelek
        .filter(t => {
            // If we have type info, use it
            const info = tlIdToInfo.get(t.tl_id);
            if (info) return info.type !== 'N';
            // Fallback: nationality entries have nemzlistas_szaz, party entries have partlistas_szaz
            return t.osszes_szavazat_partlistas_szaz != null;
        })
        .map(t => {
            const info = tlIdToInfo.get(t.tl_id);
            const coalitionCode = info ? info.coalitionCode : null;
            const coalition = coalitionCode != null ? data.coalitionMap.get(coalitionCode) : null;
            const name = coalition ? (coalition.shortName || coalition.name) : `#${t.tl_id}`;
            return {
                name,
                coalition,
                domestic: t.hazai_szavazat || 0,
                postal: t.level_szavazat || 0,
                total: t.osszes_szavazat || 0,
                pct: t.osszes_szavazat_partlistas_szaz || 0,
            };
        })
        .sort((a, b) => b.total - a.total);

    for (const e of entries) {
        const color = e.coalition ? e.coalition.color : '#888';
        const row = document.createElement('div');
        row.className = 'list-vote-row';
        row.innerHTML = `
            <span class="party-color" style="background:${color}"></span>
            <span class="party-name" title="${e.name}">${e.name}</span>
            <span class="num" style="font-variant-numeric:tabular-nums; font-size:0.82rem;">${formatNumber(e.total)} <small style="color:var(--text-muted);">(${e.pct.toFixed(1)}%)</small></span>
        `;
        container.appendChild(row);
    }
}

function commitListVoteInput(input, code) {
    const newValue = parseInt(input.value) || 0;
    const type = input.dataset.type;
    const current = state.listVotes.get(code);
    if (current && current[type] === newValue) return;

    state.setListVotes(code, type, newValue);

    // Recalculate turnout from list votes (only for domestic changes)
    if (type === 'domestic') {
        updateTurnoutFromListVotes();
    }
}

// === OEVK Detail Panel ===

function renderOevkDetail(oevkId) {
    const panel = document.getElementById('oevk-detail');
    const nameEl = document.getElementById('oevk-detail-name');
    const infoEl = document.getElementById('oevk-detail-info');
    const candidatesEl = document.getElementById('oevk-candidates-list');
    const prevEl = document.getElementById('oevk-2022-results');

    panel.classList.remove('hidden');

    const oevk = data.oevkMap.get(oevkId);
    nameEl.textContent = oevk ? `${oevk.name} (${oevkId})` : oevkId;

    // Info
    infoEl.innerHTML = oevk ? `
        <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:0.75rem;">
            ${oevk.szekhely ? `${oevk.szekhely} · ` : ''}${oevk.county || ''} · Választópolgárok: ${formatNumber(oevk.voters)}
        </div>
    ` : '';

    // === Live mode branch ===
    // In live mode, show live data instead of prediction sliders.
    // If no live data is available yet, show an empty state.
    if (liveMode) {
        renderLiveOevkDetail(oevkId, candidatesEl);
        // Keep 2022 results section as historical context
        renderPrev2022(oevkId, prevEl);
        return;
    }

    // Candidates with % sliders
    const preds = state.oevkPredictions.get(oevkId) || [];
    candidatesEl.innerHTML = '';

    // Sort: major parties first, then by current pct descending
    const sorted = [...preds].sort((a, b) => {
        const tierA = getPartyTier(a.coalitionName);
        const tierB = getPartyTier(b.coalitionName);
        if (tierA !== tierB) {
            const order = { MAJOR: 0, MINOR: 1, OTHER: 2 };
            return (order[tierA] || 2) - (order[tierB] || 2);
        }
        return b.pct - a.pct;
    });

    for (const pred of sorted) {
        const coalition = data.coalitionMap.get(pred.coalitionCode);
        const color = coalition ? coalition.color : '#888';
        const isWinner = sorted[0] === pred || pred.pct === Math.max(...sorted.map(p => p.pct));

        const row = document.createElement('div');
        row.className = `candidate-row${isWinner ? ' winner' : ''}`;
        row.innerHTML = `
            <span class="party-color" style="background:${color}"></span>
            <div>
                <div class="candidate-name">${pred.name}</div>
                <div class="candidate-party">${pred.coalitionName || 'Független'}</div>
            </div>
            <input type="number" min="0" max="100" step="0.1" value="${pred.pct.toFixed(1)}"
                   data-oevk="${oevkId}" data-candidate="${pred.candidateId}">
            <span class="candidate-pct">${formatPct(pred.pct)}</span>
        `;

        const input = row.querySelector('input');
        const pctSpan = row.querySelector('.candidate-pct');

        input.addEventListener('change', () => {
            const val = parseFloat(input.value) || 0;
            state.setCandidatePct(oevkId, pred.candidateId, val);
            // Re-render to show redistributed values
            renderOevkDetail(oevkId);
        });

        candidatesEl.appendChild(row);
    }

    // 2022 results
    renderPrev2022(oevkId, prevEl);
}

/** Render the 2022 results section into the given element. Extracted as a helper
 *  so live mode can also display historical context. */
function renderPrev2022(oevkId, prevEl) {
    const prev = data.prevResultsMap.get(oevkId);
    if (prev && prev.results.length > 0) {
        const rows = prev.results
            .sort((a, b) => b.votes - a.votes)
            .slice(0, 5)
            .map(r => `<tr><td>${r.coalition || '?'}</td><td class="num">${formatPct(r.pct)}</td><td class="num">${formatNumber(r.votes)}</td></tr>`)
            .join('');
        prevEl.innerHTML = `
            <h4 style="font-size:0.85rem; margin-top:0.75rem; color:var(--text-muted);">2022-es eredmény</h4>
            <table style="width:100%; font-size:0.75rem; margin-top:0.3rem;">
                <tr><th>Jelölő</th><th class="num">%</th><th class="num">Szavazat</th></tr>
                ${rows}
            </table>
        `;
    } else {
        prevEl.innerHTML = '';
    }
}

// === Recalculation ===

const recalculate = debounce(() => {
    if (!state || !data) return;

    const oevkVotes = state.getAllOevkVotes();

    currentAllocation = calculateSeatAllocation({
        oevkResults: oevkVotes,
        domesticListVotes: state.getDomesticListVotes(),
        postalListVotes: state.getPostalListVotes(),
        partyListMap: data.partyListMap,
        nationalityListMap: data.nationalityListMap,
        turnoutPct: state.turnoutPct,
    });

    // Update map colors (delegates to live view if live mode is on)
    applyLiveMapColors();

    // Update horseshoe (delegates to live patko when live winners view is active)
    applyHorseshoeRender();

    // Update mandate summary
    renderMandateSummary();

    // Update tables
    renderTables();
}, 100);

// === Mandate Summary ===

function renderMandateSummary() {
    const container = document.getElementById('mandate-summary');

    // Live mode + winners tab: show live mandate data from Patko.json
    if (liveMode && liveView === 'winners' && liveData.results && liveData.results.horseshoe) {
        renderLiveMandateSummary(container);
        return;
    }

    if (!currentAllocation) { container.innerHTML = ''; return; }

    const entries = [...currentAllocation.totalSeats.entries()]
        .map(([code, total]) => {
            const coalition = data.coalitionMap.get(code);
            const oevk = currentAllocation.oevkWinners.get(code) || 0;
            const list = currentAllocation.listSeats.get(code) || 0;
            const nationality = currentAllocation.nationalitySeats.get(code) || 0;
            return { code, total, oevk, list, nationality, coalition };
        })
        .sort((a, b) => b.total - a.total);

    const hasNationality = currentAllocation.nationalityMandateCount > 0;

    let html = `
        <div class="mandate-row header">
            <span></span><span>Párt</span><span class="num">OEVK</span><span class="num">Lista</span>${hasNationality ? '<span class="num">Nemz.</span>' : ''}<span class="num">Össz.</span>
        </div>
    `;

    for (const e of entries) {
        const color = e.coalition ? e.coalition.color : '#888';
        const name = e.coalition ? (e.coalition.shortName || e.coalition.name) : '?';
        html += `
            <div class="mandate-row">
                <span class="party-color" style="background:${color}"></span>
                <span>${name}</span>
                <span class="num">${e.oevk}</span>
                <span class="num">${e.list}</span>
                ${hasNationality ? `<span class="num">${e.nationality || ''}</span>` : ''}
                <span class="num mandate-total">${e.total}</span>
            </div>
        `;
    }

    if (hasNationality) {
        html += `<div class="mandate-note" style="font-size:0.7rem; color:var(--text-muted); margin-top:0.4rem;">
            Nemz.: kedvezményes nemzetiségi mandátum (${currentAllocation.nationalityMandateCount} db, listás helyek: ${currentAllocation.partyListSeats})
        </div>`;
    }

    container.innerHTML = html;
}

function renderLiveMandateSummary(container) {
    const patko = liveData.results.horseshoe;
    const eredmenyek = patko.data && patko.data.eredmenyek;
    if (!eredmenyek || !Array.isArray(eredmenyek) || eredmenyek.length === 0) {
        container.innerHTML = '';
        return;
    }

    const entries = eredmenyek
        .filter(e => e.mand_ossz > 0)
        .map(e => {
            const coalition = data.coalitionMap.get(e.jlcs_kod);
            return {
                code: e.jlcs_kod,
                coalition,
                oevk: e.mand_egyeni || 0,
                list: e.mand_listas || 0,
                total: e.mand_ossz || 0,
            };
        })
        .sort((a, b) => b.total - a.total);

    const totalMandates = patko.data.mand_kioszt || entries.reduce((s, e) => s + e.total, 0);
    const totalPossible = patko.data.mand_ossz || 199;

    let html = `
        <div class="mandate-row header">
            <span></span><span>Párt</span><span class="num">OEVK</span><span class="num">Lista</span><span class="num">Össz.</span>
        </div>
    `;

    for (const e of entries) {
        const color = e.coalition ? e.coalition.color : '#888';
        const name = e.coalition ? (e.coalition.shortName || e.coalition.name) : `#${e.code}`;
        html += `
            <div class="mandate-row">
                <span class="party-color" style="background:${color}"></span>
                <span>${escapeHtml(name)}</span>
                <span class="num">${e.oevk}</span>
                <span class="num">${e.list}</span>
                <span class="num mandate-total">${e.total}</span>
            </div>
        `;
    }

    html += `<div class="mandate-note" style="font-size:0.7rem; color:var(--text-muted); margin-top:0.4rem;">
        Kiosztott: ${totalMandates} / ${totalPossible} mandátum
    </div>`;

    container.innerHTML = html;
}

// === Tables ===

function renderTables() {
    renderOevkTable();
    renderNationalTable();
    renderFragmentTable();
}

function renderOevkTable() {
    const container = document.getElementById('oevk-table');
    if (!currentAllocation) { container.innerHTML = ''; return; }

    let rows = '';
    for (const oevk of data.oevks) {
        const preds = state.oevkPredictions.get(oevk.id) || [];
        const sorted = [...preds].sort((a, b) => b.pct - a.pct);
        const winner = sorted[0];
        const second = sorted[1];
        const winnerCoalition = winner ? data.coalitionMap.get(winner.coalitionCode) : null;
        const margin = winner && second ? (winner.pct - second.pct).toFixed(1) : '–';

        rows += `<tr data-oevk="${oevk.id}" style="cursor:pointer">
            <td>${oevk.id}</td>
            <td>${oevk.name}${oevk.szekhely ? `, ${oevk.szekhely}` : ''}</td>
            <td>
                <span class="party-color" style="background:${winnerCoalition ? winnerCoalition.color : '#888'}; display:inline-block; width:10px; height:10px; border-radius:2px; vertical-align:middle; margin-right:4px;"></span>
                ${winnerCoalition ? (winnerCoalition.shortName || winnerCoalition.name) : '–'}
            </td>
            <td class="num">${winner ? formatPct(winner.pct) : '–'}</td>
            <td class="num">${margin}%</td>
        </tr>`;
    }

    container.innerHTML = `<table>
        <thead><tr><th>Kód</th><th>Választókerület</th><th>Győztes</th><th>%</th><th>Előny</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>`;

    // Click handler on rows
    container.querySelectorAll('tr[data-oevk]').forEach(tr => {
        tr.addEventListener('click', () => onOevkClick(tr.dataset.oevk));
    });
}

function renderNationalTable() {
    const container = document.getElementById('national-table');
    if (!currentAllocation) { container.innerHTML = ''; return; }

    const hasNationality = currentAllocation.nationalityMandateCount > 0;

    const entries = [...currentAllocation.totalSeats.entries()]
        .map(([code, total]) => {
            const coalition = data.coalitionMap.get(code);
            const oevk = currentAllocation.oevkWinners.get(code) || 0;
            const list = currentAllocation.listSeats.get(code) || 0;
            const nationality = currentAllocation.nationalitySeats.get(code) || 0;
            const listVotes = currentAllocation.combinedListVotes.get(code) || 0;
            const totalListVotes = [...currentAllocation.combinedListVotes.values()].reduce((s, v) => s + v, 0);
            const listPct = totalListVotes > 0 ? (listVotes / totalListVotes * 100) : 0;
            return { code, total, oevk, list, nationality, listVotes, listPct, coalition };
        })
        .sort((a, b) => b.total - a.total);

    let rows = entries.map(e => {
        const color = e.coalition ? e.coalition.color : '#888';
        const name = e.coalition ? (e.coalition.shortName || e.coalition.name) : '?';
        const natCell = hasNationality ? `<td class="num">${e.nationality || ''}</td>` : '';
        return `<tr>
            <td><span class="party-color" style="background:${color}; display:inline-block; width:10px; height:10px; border-radius:2px; vertical-align:middle; margin-right:4px;"></span>${name}</td>
            <td class="num">${e.oevk}</td>
            <td class="num">${e.list}</td>
            ${natCell}
            <td class="num"><strong>${e.total}</strong></td>
            <td class="num">${formatNumber(e.listVotes)}</td>
            <td class="num">${formatPct(e.listPct)}</td>
        </tr>`;
    }).join('');

    const natHeader = hasNationality ? '<th>Nemz.</th>' : '';

    container.innerHTML = `<table>
        <thead><tr><th>Párt</th><th>OEVK</th><th>Lista</th>${natHeader}<th>Össz.</th><th>Listás szav.</th><th>Lista %</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>`;
}

function renderFragmentTable() {
    const container = document.getElementById('fragment-table');
    if (!currentAllocation) { container.innerHTML = ''; return; }

    const entries = [...currentAllocation.fragmentVotes.entries()]
        .map(([code, votes]) => {
            const coalition = data.coalitionMap.get(code);
            const name = coalition ? (coalition.shortName || coalition.name) : '?';
            const color = coalition ? coalition.color : '#888';
            return { code, votes, name, color };
        })
        .sort((a, b) => b.votes - a.votes);

    let rows = entries.map(e => `<tr>
        <td><span class="party-color" style="background:${e.color}; display:inline-block; width:10px; height:10px; border-radius:2px; vertical-align:middle; margin-right:4px;"></span>${e.name}</td>
        <td class="num">${formatNumber(e.votes)}</td>
    </tr>`).join('');

    container.innerHTML = `<table>
        <thead><tr><th>Párt</th><th>Töredékszavazat</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>`;
}

// === Table tab switching ===

function setupTableTabs() {
    const tabs = document.querySelectorAll('.table-tabs .tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            document.querySelectorAll('.table-container').forEach(c => c.classList.add('hidden'));
            document.querySelectorAll('.table-container').forEach(c => c.classList.remove('active'));
            const target = document.getElementById(tab.dataset.table);
            if (target) {
                target.classList.remove('hidden');
                target.classList.add('active');
            }
        });
    });
}

// === OEVK detail close ===

function setupOevkDetailClose() {
    document.getElementById('oevk-detail-close').addEventListener('click', () => {
        document.getElementById('oevk-detail').classList.add('hidden');
        selectedOevkId = null;
    });
}

// === Auto-fill from polling ===

async function handleAutoFill() {
    const btn = document.getElementById('btn-auto-fill');
    btn.disabled = true;
    btn.textContent = 'Polling betöltése...';

    try {
        const allPolls = await fetchPollingData();

        // Apply firm bias filter from selector (defaults to "all" if element missing)
        var filterEl = document.getElementById('poll-filter');
        var filter = filterEl ? filterEl.value : 'all';
        var polls = filterPollsByBias(allPolls, filter);
        var avg = averageRecentPolls(polls, 5);

        if (!avg) {
            alert('Nem talalhato polling adat a kivalasztott szurovel.');
            return;
        }

        // Map polling percentages to coalition codes
        // This requires matching polling party names to our coalition data
        const pollingToCoalition = mapPollingToCoalitions(avg, data);

        // Re-init OEVK predictions from 2022 base before applying swing
        // (otherwise after reset, all pcts are 0 and swing produces garbage)
        state.reinitOevkPredictions();

        // Apply swing to OEVK predictions
        applySwingFromPolling(avg, data, state);

        // Apply list votes
        state.applyPollingData(state.oevkPredictions, pollingToCoalition);

        // Refresh UI
        renderControlPanel();
        renderListVotes();
        if (selectedOevkId) renderOevkDetail(selectedOevkId);

        var filterLabel = filter === 'gov' ? ', korm.' : filter === 'opp' ? ', ell.' : '';
        btn.textContent = 'Kitoltve (' + polls.length + ' poll' + filterLabel + ')';

    } catch (err) {
        console.error('Polling error:', err);
        alert(`Polling hiba: ${err.message}`);
        btn.textContent = 'Auto kitöltés polling alapján';
    } finally {
        btn.disabled = false;
    }
}

/**
 * Map polling percentages to coalition codes.
 */
function mapPollingToCoalitions(avg, data) {
    const result = new Map();

    for (const [code, coalition] of data.coalitionMap) {
        if (!data.partyListMap.has(code)) continue;

        const name = (coalition.shortName || coalition.name || '').toUpperCase();
        let pct = 0;

        if (name.includes('FIDESZ')) pct = avg.fidesz;
        else if (name.includes('TISZA')) pct = avg.tisza;
        else if (name.includes('DK') && !name.includes('KDNP')) pct = avg.dk;
        else if (name.includes('HAZÁNK') || name.includes('HAZANK')) pct = avg.miHazank;
        else if (name.includes('MKKP')) pct = avg.mkkp;
        else pct = avg.others / Math.max(1, data.partyLists.filter(l => l.type !== 'N').length - 5);

        result.set(code, pct);
    }

    return result;
}

/**
 * Apply uniform national swing from polling to OEVK predictions.
 */
function applySwingFromPolling(avg, data, state) {
    // 2022 national results (approximate)
    const national2022 = {
        fidesz: 54.1,
        opposition: 34.4, // DK-Jobbik-Momentum-MSZP-LMP-Párbeszéd
        miHazank: 5.9,
        mkkp: 3.3,
        others: 2.3,
    };

    // 2026 swing
    const swing = {
        fidesz: avg.fidesz - national2022.fidesz,
        tisza: avg.tisza - national2022.opposition, // TISZA inherits opposition base
        dk: avg.dk - 0, // DK was part of coalition, ~0 standalone in 2022
        miHazank: avg.miHazank - national2022.miHazank,
        mkkp: avg.mkkp - national2022.mkkp,
    };

    for (const [oevkId, preds] of state.oevkPredictions) {
        for (const pred of preds) {
            if (pred.isManuallySet) continue;

            const name = pred.coalitionName.toUpperCase();
            let swingVal = 0;

            if (name.includes('FIDESZ')) swingVal = swing.fidesz;
            else if (name.includes('TISZA')) swingVal = swing.tisza;
            else if (name.includes('DK') && !name.includes('KDNP')) swingVal = swing.dk;
            else if (name.includes('HAZÁNK') || name.includes('HAZANK')) swingVal = swing.miHazank;
            else if (name.includes('MKKP')) swingVal = swing.mkkp;

            pred.pct = Math.max(0, pred.pct + swingVal);
        }

        // Renormalize
        const sum = preds.reduce((s, p) => s + p.pct, 0);
        if (sum > 0 && Math.abs(sum - 100) > 0.1) {
            const factor = 100 / sum;
            preds.forEach(p => p.pct *= factor);
        }
    }
}

// === Reset ===

function handleReset() {
    state.resetAll();
    renderControlPanel();
    if (selectedOevkId) renderOevkDetail(selectedOevkId);
}

// === Event Setup ===

function setupEventListeners() {
    // Prediction changes trigger recalculation
    bus.on('prediction-changed', recalculate);

    // Table tabs
    setupTableTabs();

    // OEVK detail close
    setupOevkDetailClose();

    // Auto-fill button
    document.getElementById('btn-auto-fill').addEventListener('click', handleAutoFill);

    // Reset button
    document.getElementById('btn-reset').addEventListener('click', handleReset);

    // Live mode
    setupLiveMode();
}

// === Live mode ===

function setupLiveMode() {
    const btn = document.getElementById('btn-live');
    const panel = document.getElementById('live-panel');
    const refreshBtn = document.getElementById('btn-live-refresh');

    // Defensive: if the live mode DOM is missing (e.g. user has a stale
    // cached index.html without the live elements), skip setup gracefully
    // so the rest of the app continues to work.
    if (!btn || !panel) {
        console.warn('Live mode DOM not found - skipping setup. Hard refresh (Ctrl+Shift+R) may be required.');
        return;
    }

    // Restore last live snapshot from localStorage on every load (so users see
    // the most recent data even if polling has not yet returned).
    hydrateLiveFromStore();

    btn.addEventListener('click', () => {
        liveMode = !liveMode;
        btn.classList.toggle('active', liveMode);
        panel.classList.toggle('hidden', !liveMode);
        // Hide the turnout slider section in live mode (live turnout comes from vtr)
        const turnoutSection = document.getElementById('turnout-section');
        if (turnoutSection) turnoutSection.classList.toggle('hidden', liveMode);
        if (liveMode) {
            livePoller.start();
            // Force an immediate refresh on activation
            livePoller.pollNow().catch(err => console.error('initial pollNow', err));
        } else {
            livePoller.stop();
            // Restore prediction view on map
            liveView = 'prediction';
            updateLiveViewTabs();
            applyLiveMapColors();
        }
        applyHorseshoeRender();
        renderListVotes();
        renderMandateSummary();
        if (selectedOevkId) renderOevkDetail(selectedOevkId);
        renderLiveStatus();
    });

    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            refreshBtn.disabled = true;
            livePoller.pollNow().finally(() => { refreshBtn.disabled = false; });
        });
    }

    // View tabs
    document.querySelectorAll('.live-view-tabs .tab').forEach(tab => {
        tab.addEventListener('click', () => {
            liveView = tab.dataset.liveView;
            updateLiveViewTabs();
            applyLiveMapColors();
            applyHorseshoeRender();
            renderListVotes();
            renderMandateSummary();
            // Re-render OEVK detail in case the user switched between predikcio and live views
            if (selectedOevkId) renderOevkDetail(selectedOevkId);
        });
    });

    // Wire up bus events from livePoller
    bus.on('live-config', ({ config, changed }) => {
        liveData.config = config;
        renderLiveStatus();
    });

    bus.on('live-turnout', (payload) => {
        liveData.turnout = payload;
        renderLiveTurnoutTiles();
        if (liveView === 'turnout') applyLiveMapColors();
        if (liveMode && selectedOevkId) renderOevkDetail(selectedOevkId);
    });

    bus.on('live-events', (payload) => {
        liveData.events = payload;
        renderLiveEvents();
    });

    bus.on('live-results', (payload) => {
        liveData.results = payload;
        // Results contain accurate turnout data (OevkJkv) - update turnout tiles too
        renderLiveTurnoutTiles();
        if (liveView === 'turnout') applyLiveMapColors();
        if (liveView === 'winners') applyLiveMapColors();
        applyHorseshoeRender();
        renderFeldarTile();
        renderListVotes();
        renderMandateSummary();
        if (liveMode && selectedOevkId) renderOevkDetail(selectedOevkId);
    });

    bus.on('live-error', ({ error }) => {
        const box = document.getElementById('live-error-box');
        if (box) {
            box.innerHTML = `<div class="live-error">Hiba: ${escapeHtml(error)}</div>`;
        }
    });

    bus.on('live-poll-state', renderLiveStatus);
}

function hydrateLiveFromStore() {
    const t = getLatest('turnout_oevk');
    if (t) liveData.turnout = { ...liveData.turnout, oevk: t.data, ver: t.ver };
    const tn = getLatest('turnout_national');
    if (tn) liveData.turnout = { ...liveData.turnout, national: tn.data, ver: tn.ver };
    const ev = getLatest('events_napkozi') || getLatest('events_szavossz');
    if (ev) liveData.events = { events: ev.data, ver: ev.ver };
    const w = getLatest('results_winners');
    if (w) liveData.results = { ...liveData.results, winners: w.data, ver: w.ver };
    const h = getLatest('results_horseshoe');
    if (h) liveData.results = { ...liveData.results, horseshoe: h.data };

    if (liveData.turnout) renderLiveTurnoutTiles();
    if (liveData.events) renderLiveEvents();
}

function updateLiveViewTabs() {
    document.querySelectorAll('.live-view-tabs .tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.liveView === liveView);
    });
}

function renderLiveStatus() {
    const status = livePoller.getStatus();
    const badge = document.getElementById('live-source-badge');
    const lastUpdate = document.getElementById('live-last-update');
    const errBox = document.getElementById('live-error-box');

    if (badge) {
        badge.classList.remove('napkozi', 'szavossz', 'none');
        if (status.source === 'szavossz') {
            badge.classList.add('szavossz');
            badge.textContent = 'Eredmeny';
        } else if (status.source === 'napkozi') {
            badge.classList.add('napkozi');
            badge.textContent = 'Reszvetel';
        } else {
            badge.classList.add('none');
            badge.textContent = 'Nincs adat';
        }
    }

    if (lastUpdate) {
        const ts = Math.max(status.lastConfigFetchTs, status.lastTurnoutFetchTs, status.lastResultFetchTs);
        if (ts > 0) {
            const d = new Date(ts);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            const ss = String(d.getSeconds()).padStart(2, '0');
            lastUpdate.textContent = `${hh}:${mm}:${ss}`;
        } else {
            lastUpdate.textContent = '-';
        }
    }

    if (errBox && !status.lastError) {
        errBox.innerHTML = '';
    }
}

/**
 * Extract national turnout percentage from ReszvetelOrszag.json (napkozi).
 * Schema is best-effort: looks for common field names; returns null if unparseable.
 */
function extractNationalTurnoutPctFromNapkozi(payload) {
    if (!payload) return null;
    if (typeof payload.szazalek === 'number') return payload.szazalek;
    if (payload.data && typeof payload.data.szazalek === 'number') return payload.data.szazalek;
    if (payload.list && Array.isArray(payload.list)) {
        const row = payload.list[payload.list.length - 1];
        if (row) {
            if (typeof row.szazalek === 'number') return row.szazalek;
            if (typeof row.reszv_szaz === 'number') return row.reszv_szaz;
            const voted = row.megjelent ?? row.megj ?? null;
            const total = row.osszesen ?? row.valp ?? null;
            if (typeof voted === 'number' && typeof total === 'number' && total > 0) {
                return (voted / total) * 100;
            }
        }
    }
    return null;
}

/**
 * Extract national turnout from OevkJkv.json (szavossz).
 * Uses szavazott_osszesen / vp_osszes which is more accurate than napkozi
 * because vp_osszes excludes átjelentkezettek (re-registered voters).
 * Returns { pct, voted, total } or null.
 */
function extractNationalTurnoutFromResults(payload) {
    if (!payload) return null;
    const list = payload.list || payload.data || [];
    if (!Array.isArray(list) || list.length === 0) return null;
    let totalVoted = 0, totalVoters = 0;
    for (const row of list) {
        if (!row) continue;
        const jkv = row.egyeni_jkv || row;
        const voted = jkv.szavazott_osszesen;
        const voters = jkv.vp_osszes;
        if (typeof voted === 'number' && typeof voters === 'number') {
            totalVoted += voted;
            totalVoters += voters;
        }
    }
    if (totalVoters === 0) return null;
    return { pct: (totalVoted / totalVoters) * 100, voted: totalVoted, total: totalVoters };
}

/**
 * Get the best national turnout percentage.
 * Prefers szavossz (OevkJkv) data over napkozi because it uses final voter counts.
 */
function extractNationalTurnoutPct(napkoziPayload) {
    const fromResults = extractNationalTurnoutFromResults(
        liveData.results && liveData.results.oevkRes
    );
    if (fromResults) return fromResults.pct;
    return extractNationalTurnoutPctFromNapkozi(napkoziPayload);
}

/**
 * Extract per-OEVK turnout map from ReszvetelOevk.json (napkozi).
 * Returns Map<oevkId, pct>.
 */
function extractOevkTurnoutMapFromNapkozi(payload) {
    const map = new Map();
    if (!payload) return map;
    const list = payload.list || payload.data || [];
    if (!Array.isArray(list)) return map;
    for (const row of list) {
        if (row == null) continue;
        const maz = row.maz != null ? String(row.maz).padStart(2, '0') : null;
        const evk = row.evk != null ? String(row.evk).padStart(2, '0') : null;
        if (!maz || !evk) continue;
        const id = `${maz}-${evk}`;
        let pct = null;
        if (typeof row.szazalek === 'number') pct = row.szazalek;
        else if (typeof row.reszv_szaz === 'number') pct = row.reszv_szaz;
        else {
            const voted = row.megjelent ?? row.megj ?? null;
            const total = row.osszesen ?? row.valp ?? null;
            if (typeof voted === 'number' && typeof total === 'number' && total > 0) {
                pct = (voted / total) * 100;
            }
        }
        if (pct != null) map.set(id, pct);
    }
    return map;
}

/**
 * Extract per-OEVK turnout map from OevkJkv.json (szavossz).
 * Uses szavazott_osszesen_szaz which is based on final voter counts (vp_osszes).
 * Returns Map<oevkId, pct>.
 */
function extractOevkTurnoutMapFromResults(payload) {
    const map = new Map();
    if (!payload) return map;
    const list = payload.list || payload.data || [];
    if (!Array.isArray(list)) return map;
    for (const row of list) {
        if (!row) continue;
        const maz = row.maz != null ? String(row.maz).padStart(2, '0') : null;
        const evk = row.evk != null ? String(row.evk).padStart(2, '0') : null;
        if (!maz || !evk) continue;
        const id = `${maz}-${evk}`;
        const jkv = row.egyeni_jkv || row;
        if (typeof jkv.szavazott_osszesen_szaz === 'number') {
            map.set(id, jkv.szavazott_osszesen_szaz);
        }
    }
    return map;
}

/**
 * Get the best per-OEVK turnout map.
 * Prefers szavossz data, fills gaps with napkozi data.
 */
function extractOevkTurnoutMap(napkoziPayload) {
    const fromResults = extractOevkTurnoutMapFromResults(
        liveData.results && liveData.results.oevkRes
    );
    const fromNapkozi = extractOevkTurnoutMapFromNapkozi(napkoziPayload);
    // Merge: szavossz takes precedence, napkozi fills gaps
    if (fromResults.size > 0) {
        for (const [id, pct] of fromNapkozi) {
            if (!fromResults.has(id)) fromResults.set(id, pct);
        }
        return fromResults;
    }
    return fromNapkozi;
}

/**
 * Extract turnout detail for a single OEVK from napkozi data.
 * Returns { pct, voted, total } or null.
 */
function extractOevkTurnoutDetailFromNapkozi(oevkId, payload) {
    if (!payload || !oevkId) return null;
    const list = payload.list || payload.data || [];
    if (!Array.isArray(list)) return null;
    const [maz, evk] = oevkId.split('-');
    let row = null;
    for (const r of list) {
        if (!r) continue;
        const m = r.maz != null ? String(r.maz).padStart(2, '0') : null;
        const e = r.evk != null ? String(r.evk).padStart(2, '0') : null;
        if (m === maz && e === evk) row = r;
    }
    if (!row) return null;
    let pct = null, voted = null, total = null;
    if (typeof row.szazalek === 'number') pct = row.szazalek;
    else if (typeof row.reszv_szaz === 'number') pct = row.reszv_szaz;
    voted = row.megjelent ?? row.megj ?? null;
    total = row.osszesen ?? row.valp ?? null;
    if (pct == null && typeof voted === 'number' && typeof total === 'number' && total > 0) {
        pct = (voted / total) * 100;
    }
    if (pct == null && voted == null) return null;
    return { pct, voted, total };
}

/**
 * Extract turnout detail for a single OEVK from OevkJkv.json (szavossz).
 * Returns { pct, voted, total } or null.
 */
function extractOevkTurnoutDetailFromResults(oevkId, payload) {
    if (!payload || !oevkId) return null;
    const list = payload.list || payload.data || [];
    if (!Array.isArray(list)) return null;
    const [maz, evk] = oevkId.split('-');
    for (const r of list) {
        if (!r) continue;
        const m = r.maz != null ? String(r.maz).padStart(2, '0') : null;
        const e = r.evk != null ? String(r.evk).padStart(2, '0') : null;
        if (m !== maz || e !== evk) continue;
        const jkv = r.egyeni_jkv || r;
        const pct = typeof jkv.szavazott_osszesen_szaz === 'number' ? jkv.szavazott_osszesen_szaz : null;
        const voted = typeof jkv.szavazott_osszesen === 'number' ? jkv.szavazott_osszesen : null;
        const total = typeof jkv.vp_osszes === 'number' ? jkv.vp_osszes : null;
        if (pct != null || voted != null) return { pct, voted, total };
    }
    return null;
}

/**
 * Get the best turnout detail for a single OEVK.
 * Prefers szavossz (OevkJkv) over napkozi.
 */
function extractOevkTurnoutDetail(oevkId, napkoziPayload) {
    const fromResults = extractOevkTurnoutDetailFromResults(
        oevkId, liveData.results && liveData.results.oevkRes
    );
    if (fromResults) return fromResults;
    return extractOevkTurnoutDetailFromNapkozi(oevkId, napkoziPayload);
}

/**
 * Extract live results (per-candidate votes) for a single OEVK from OevkJkv.json.
 * Schema (from vtr SPA bundle): list[i].egyeni_jkv.tetelek[j] with ej_id, mandatum, vote count.
 * Vote count field name varies - try several.
 * Returns array of { ej_id, votes, mandatum, pct } sorted by votes desc, or null.
 */
function extractOevkLiveResults(oevkId, payload) {
    if (!payload || !oevkId) return null;
    const list = payload.list || payload.data || [];
    if (!Array.isArray(list)) return null;
    const [maz, evk] = oevkId.split('-');
    // Take the last matching row (latest reporting round)
    let row = null;
    for (const r of list) {
        if (!r) continue;
        const m = r.maz != null ? String(r.maz).padStart(2, '0') : null;
        const e = r.evk != null ? String(r.evk).padStart(2, '0') : null;
        if (m === maz && e === evk) row = r;
    }
    if (!row) return null;
    const tetelek = (row.egyeni_jkv && row.egyeni_jkv.tetelek) || row.tetelek || [];
    if (!Array.isArray(tetelek) || tetelek.length === 0) return null;

    const items = tetelek.map(t => {
        let votes = 0;
        if (typeof t.szavazat === 'number') votes = t.szavazat;
        else if (typeof t.osszes === 'number') votes = t.osszes;
        else if (typeof t.ervenyes === 'number') votes = t.ervenyes;
        else if (typeof t.darab === 'number') votes = t.darab;
        return {
            ej_id: t.ej_id,
            votes,
            mandatum: t.mandatum || 0,
        };
    });
    const totalVotes = items.reduce((s, i) => s + i.votes, 0);
    items.forEach(i => { i.pct = totalVotes > 0 ? (i.votes / totalVotes * 100) : 0; });
    items.sort((a, b) => b.votes - a.votes);
    return items;
}

/**
 * Extract winner coalition code per OEVK from OevkElsok.json.
 * Returns Map<oevkId, coalitionCode>.
 */
function extractWinnersMap(payload) {
    const map = new Map();
    if (!payload || !data) return map;
    const list = payload.list || payload.data || [];
    if (!Array.isArray(list)) return map;

    // Build ej_id -> coalitionCode lookup from candidate data
    const ejIdToCoalition = new Map();
    if (data.candidates) {
        for (const c of data.candidates) {
            ejIdToCoalition.set(c.id, c.coalitionCode);
        }
    }

    for (const row of list) {
        if (!row) continue;
        const maz = row.maz != null ? String(row.maz).padStart(2, '0') : null;
        const evk = row.evk != null ? String(row.evk).padStart(2, '0') : null;
        if (!maz || !evk) continue;
        const id = `${maz}-${evk}`;
        // OevkElsok has ej_id (candidate ID), not jlcs_kod directly
        const code = row.jlcs_kod ?? ejIdToCoalition.get(row.ej_id) ?? row.coalitionCode;
        if (code != null) map.set(id, code);
    }
    return map;
}

/**
 * Extract feldolgozottsag (processing %) for an OEVK from OevkJkv.json.
 */
function extractOevkFeldar(oevkId, payload) {
    if (!payload || !oevkId) return null;
    const list = payload.list || payload.data || [];
    if (!Array.isArray(list)) return null;
    const [maz, evk] = oevkId.split('-');
    let row = null;
    for (const r of list) {
        if (!r) continue;
        const m = r.maz != null ? String(r.maz).padStart(2, '0') : null;
        const e = r.evk != null ? String(r.evk).padStart(2, '0') : null;
        if (m === maz && e === evk) row = r;
    }
    if (!row) return null;
    const jkv = row.egyeni_jkv || row;
    return typeof jkv.feldar === 'number' ? jkv.feldar : null;
}

/**
 * Extract national feldolgozottsag from Patko.json or ListasJkv.json.
 */
function extractNationalFeldar() {
    const patko = liveData.results && liveData.results.horseshoe;
    if (patko && patko.data && typeof patko.data.feldar === 'number') return patko.data.feldar;
    const listas = liveData.results && liveData.results.listRes;
    if (listas && listas.list && listas.list.length > 0) {
        const row = listas.list.find(e => e.oszint === '5' || e.oszint === 5) || listas.list[0];
        if (typeof row.feldar === 'number') return row.feldar;
    }
    return null;
}

function renderLiveTurnoutTiles() {
    const t = liveData.turnout;
    const ttNat = document.getElementById('live-tt-national');
    const ttNatSub = document.getElementById('live-tt-national-sub');
    const ttOevk = document.getElementById('live-tt-oevk');
    const ttOevkSub = document.getElementById('live-tt-oevk-sub');

    // National turnout: prefer szavossz (OevkJkv) data
    const natFromResults = extractNationalTurnoutFromResults(
        liveData.results && liveData.results.oevkRes
    );
    const natPct = natFromResults
        ? natFromResults.pct
        : extractNationalTurnoutPctFromNapkozi(t && t.national);

    if (ttNat) ttNat.textContent = natPct != null ? (natPct.toFixed(1) + '%') : '-';
    if (ttNatSub && natPct != null) {
        if (natFromResults) {
            ttNatSub.textContent = formatNumber(natFromResults.voted) + ' szavazó';
        } else {
            const natList = t && t.national && t.national.list;
            const natRow = natList && natList.length ? natList[natList.length - 1] : null;
            const voted = natRow ? (natRow.megjelent ?? natRow.megj ?? null) : null;
            if (typeof voted === 'number') {
                ttNatSub.textContent = formatNumber(voted) + ' szavazó';
            } else {
                const total = data && data.nationalTotals ? data.nationalTotals.totalVoters : 0;
                const est = total > 0 ? Math.round(total * natPct / 100) : 0;
                ttNatSub.textContent = est ? (formatNumber(est) + ' szavazó') : '';
            }
        }
    }
}

function renderFeldarTile() {
    const ttFeldar = document.getElementById('live-tt-feldar');
    const ttFeldarSub = document.getElementById('live-tt-feldar-sub');
    const feldar = extractNationalFeldar();
    if (ttFeldar) ttFeldar.textContent = feldar != null ? (feldar.toFixed(1) + '%') : '–';
    if (ttFeldarSub) {
        // Count OEVKs with results
        const oevkRes = liveData.results && liveData.results.oevkRes;
        if (oevkRes) {
            const list = oevkRes.list || [];
            const withData = new Set();
            for (const r of list) {
                if (r && r.maz != null && r.evk != null) {
                    withData.add(`${String(r.maz).padStart(2,'0')}-${String(r.evk).padStart(2,'0')}`);
                }
            }
            ttFeldarSub.textContent = withData.size > 0 ? `${withData.size} / 106 OEVK` : '';
        } else {
            ttFeldarSub.textContent = '';
        }
    }
}

function renderLiveEvents() {
    const list = document.getElementById('live-events-list');
    if (!list) return;
    const countEl = document.getElementById('live-events-count');
    const payload = liveData.events && liveData.events.events;
    const items = payload && (payload.list || payload.data || (Array.isArray(payload) ? payload : []));
    if (!items || !items.length) {
        list.innerHTML = '';
        if (countEl) countEl.textContent = '';
        return;
    }
    if (countEl) countEl.textContent = `(${items.length})`;
    // Newest first; render up to 20
    const sorted = [...items].sort((a, b) => {
        const ta = new Date(a.jelido || a.ido || a.idopont || a.datum || 0).getTime();
        const tb = new Date(b.jelido || b.ido || b.idopont || b.datum || 0).getTime();
        return tb - ta;
    }).slice(0, 3);

    list.innerHTML = sorted.map(ev => {
        const t = ev.jelido || ev.ido || ev.idopont || ev.datum || '';
        const text = ev.esemeny || ev.szoveg || ev.leiras || ev.megnevezes || ev.text || '';
        const action = ev.intezkedes || '';
        // Location: megye + OEVK
        const loc = ev.maz && ev.evk ? `${ev.maz}-${ev.evk}` : (ev.maz || '');
        let timeLabel = '';
        if (t) {
            try {
                const d = new Date(t);
                if (!isNaN(d.getTime())) {
                    timeLabel = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                }
            } catch (e) { /* ignore */ }
        }
        const locHtml = loc ? `<span class="ev-loc">[${escapeHtml(loc)}]</span> ` : '';
        const actionHtml = action ? `<div class="ev-action">${escapeHtml(String(action).slice(0, 200))}</div>` : '';
        return `<div class="live-event-item">
            <div class="ev-time">${escapeHtml(timeLabel)}</div>
            <div class="ev-text">${locHtml}${escapeHtml(String(text).slice(0, 300))}${actionHtml}</div>
        </div>`;
    }).join('');
}

/**
 * Compute a heat color for a turnout percentage.
 * Low (30%) = blue, mid (55%) = yellow, high (75%+) = red.
 */
/**
 * Build a turnout heat color function relative to the actual data range.
 * Light (low turnout) → Dark (high turnout), single-hue blue scale.
 */
function makeTurnoutColorFn(oevkMap) {
    const vals = [...oevkMap.values()].filter(v => v != null && v > 0);
    if (vals.length === 0) return () => '#444';
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const range = hi - lo;
    return (pct) => {
        if (pct == null) return '#444';
        // Normalize to 0..1 within the actual data range
        const t = range > 0.1 ? Math.max(0, Math.min(1, (pct - lo) / range)) : 0.5;
        // Light blue (low) → Dark blue (high)
        const l = 85 - t * 50; // lightness: 85% (light) → 35% (dark)
        const s = 55 + t * 20; // saturation: 55% → 75%
        return `hsl(215, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`;
    };
}

function applyLiveMapColors() {
    if (!data) return;
    if (liveView === 'prediction' || !liveMode) {
        // Restore prediction colors
        updateAllColors((oevkId) => {
            if (!currentAllocation) return '#444';
            const winnerCode = currentAllocation.oevkWinnerByDistrict.get(oevkId);
            if (winnerCode == null) return '#444';
            const coalition = data.coalitionMap.get(winnerCode);
            return coalition ? coalition.color : '#888';
        });
        return;
    }

    if (liveView === 'turnout') {
        const oevkMap = extractOevkTurnoutMap(liveData.turnout && liveData.turnout.oevk);
        const colorFn = makeTurnoutColorFn(oevkMap);
        updateAllColors((oevkId) => colorFn(oevkMap.get(oevkId)));
        return;
    }

    if (liveView === 'winners') {
        const winners = extractWinnersMap(liveData.results && liveData.results.winners);
        updateAllColors((oevkId) => {
            const code = winners.get(oevkId);
            // Grey when no live winner yet - explicit signal that data is missing
            if (code == null) return '#3a3a52';
            const coalition = data.coalitionMap.get(code);
            return coalition ? coalition.color : '#888';
        });
        return;
    }
}

/**
 * Render the OEVK detail panel content for live mode.
 * Shows live turnout and (when available) live per-candidate vote counts.
 * If no live data exists yet for this OEVK, shows an explicit empty state.
 */
function renderLiveOevkDetail(oevkId, container) {
    container.innerHTML = '';

    // Step 1 - Turnout block
    const turnoutDetail = liveData.turnout
        ? extractOevkTurnoutDetail(oevkId, liveData.turnout.oevk)
        : null;

    let html = '<div style="margin-top:0.4rem;">';
    html += '<h4 style="font-size:0.8rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:0.4rem;">Elo reszvetel</h4>';
    if (turnoutDetail) {
        const pctStr = turnoutDetail.pct != null ? turnoutDetail.pct.toFixed(1) + '%' : '-';
        const votedStr = turnoutDetail.voted != null ? formatNumber(turnoutDetail.voted) : '-';
        const totalStr = turnoutDetail.total != null ? formatNumber(turnoutDetail.total) : '-';
        html += `<div style="background:var(--bg-elevated); padding:0.5rem 0.6rem; border-radius:var(--radius-sm); border:1px solid var(--border);">`;
        html += `<div style="font-size:1.4rem; font-weight:700; font-variant-numeric:tabular-nums;">${pctStr}</div>`;
        html += `<div style="font-size:0.72rem; color:var(--text-muted);">${votedStr} / ${totalStr} szavazo</div>`;
        html += `</div>`;
    } else {
        html += '<div style="font-size:0.78rem; color:var(--text-dim); font-style:italic;">Nincs elo reszveteli adat.</div>';
    }
    html += '</div>';

    // Step 2 - Live results block (per-candidate votes if available)
    const liveResults = liveData.results
        ? extractOevkLiveResults(oevkId, liveData.results.oevkRes)
        : null;

    // Feldolgozottság
    const feldar = extractOevkFeldar(oevkId, liveData.results && liveData.results.oevkRes);
    if (feldar != null) {
        html += `<div style="margin-top:0.5rem; font-size:0.78rem; color:var(--text-muted);">Feldolgozottság: <strong style="color:var(--text);">${feldar.toFixed(1)}%</strong></div>`;
    }

    html += '<div style="margin-top:0.8rem;">';
    html += '<h4 style="font-size:0.8rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:0.4rem;">Elo eredmenyek</h4>';
    if (liveResults && liveResults.length > 0) {
        // Build candidate lookup from data.candidatesByOevk
        const candidates = data.candidatesByOevk.get(oevkId) || [];
        const candById = new Map(candidates.map(c => [c.id, c]));

        html += '<div style="display:flex; flex-direction:column; gap:0.25rem;">';
        for (const r of liveResults) {
            const cand = candById.get(r.ej_id);
            const name = cand ? cand.name : ('#' + r.ej_id);
            const coalitionCode = cand ? cand.coalitionCode : null;
            const coalition = coalitionCode != null ? data.coalitionMap.get(coalitionCode) : null;
            const color = coalition ? coalition.color : '#888';
            const isWinner = r.mandatum > 0;
            html += `<div class="candidate-row${isWinner ? ' winner' : ''}" style="grid-template-columns: 10px 1fr 70px 55px;">
                <span class="party-color" style="background:${color}"></span>
                <div>
                    <div class="candidate-name">${escapeHtml(name)}</div>
                    <div class="candidate-party">${coalition ? escapeHtml(coalition.shortName || coalition.name) : ''}</div>
                </div>
                <span class="num" style="font-variant-numeric:tabular-nums;">${formatNumber(r.votes)}</span>
                <span class="candidate-pct">${r.pct.toFixed(1)}%</span>
            </div>`;
        }
        html += '</div>';
    } else {
        html += '<div style="font-size:0.78rem; color:var(--text-dim); font-style:italic;">Nincs elo eredmeny adat.</div>';
    }
    html += '</div>';

    container.innerHTML = html;
}

/**
 * Render the horseshoe from live Patko data.
 * Patko schema (best-effort): { list: [{ jlcs_kod, mandatum, ... }] } or { data: { ... } }
 * Returns true if successfully rendered from live data, false otherwise.
 */
function renderLiveHorseshoe(patko) {
    if (!patko || !data) return false;
    // Patko.json schema: { data: { eredmenyek: [{ jlcs_kod, mand_ossz, mand_egyeni, mand_listas }] } }
    const list = patko.list
        || (patko.data && patko.data.eredmenyek)
        || (Array.isArray(patko) ? patko : []);
    if (!Array.isArray(list) || list.length === 0) return false;
    const seats = new Map();
    for (const row of list) {
        if (!row) continue;
        const code = row.jlcs_kod ?? row.coalitionCode;
        const m = row.mand_ossz ?? row.mandatum ?? row.osszes ?? row.seats;
        if (code != null && typeof m === 'number') {
            seats.set(code, (seats.get(code) || 0) + m);
        }
    }
    if (seats.size === 0) return false;
    renderHorseshoe(seats, data.coalitionMap);
    return true;
}

/**
 * Decide which horseshoe rendering to use based on current mode and active view.
 * - Live mode + Elo gyoztes tab + live patko available -> live
 * - Otherwise -> prediction (currentAllocation)
 *
 * Reszvetel tab does NOT change the horseshoe (turnout has no seat impact).
 */
function applyHorseshoeRender() {
    if (!data) return;
    if (liveMode && liveView === 'winners' && liveData.results && liveData.results.horseshoe) {
        const ok = renderLiveHorseshoe(liveData.results.horseshoe);
        if (ok) return;
    }
    // Fallback: prediction
    if (currentAllocation) {
        renderHorseshoe(currentAllocation.totalSeats, data.coalitionMap);
    }
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// === Start ===
document.addEventListener('DOMContentLoaded', init);
