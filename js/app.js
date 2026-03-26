// === Main application entry point ===

import { loadAllData } from './data.js';
import { renderMap, updateAllColors, showTooltip } from './map.js';
import { renderHorseshoe } from './horseshoe.js';
import { calculateSeatAllocation } from './electoral-math.js';
import { PredictionState } from './prediction.js';
import { fetchPollingData, averageRecentPolls, filterPollsByBias } from './polling.js';
import { bus, formatNumber, formatPct, debounce, getPartyTier } from './utils.js';

let data = null;
let state = null;
let currentAllocation = null;
let selectedOevkId = null;
let activeListTab = 'domestic';

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
    showTooltip(oevkId, event, data, state);
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
            ${oevk.county || ''} · Választópolgárok: ${formatNumber(oevk.voters)}
        </div>
    ` : '';

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

    // Update map colors
    updateAllColors((oevkId) => {
        const winnerCode = currentAllocation.oevkWinnerByDistrict.get(oevkId);
        if (winnerCode == null) return '#444';
        const coalition = data.coalitionMap.get(winnerCode);
        return coalition ? coalition.color : '#888';
    });

    // Update horseshoe
    renderHorseshoe(currentAllocation.totalSeats, data.coalitionMap);

    // Update mandate summary
    renderMandateSummary();

    // Update tables
    renderTables();
}, 100);

// === Mandate Summary ===

function renderMandateSummary() {
    const container = document.getElementById('mandate-summary');
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
            <td>${oevk.name}</td>
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
}

// === Start ===
document.addEventListener('DOMContentLoaded', init);
