// === Prediction state management ===

import { bus, getPartyTier } from './utils.js?v=3';
import { pctToVotes } from './electoral-math.js?v=3';

/**
 * PredictionState holds all user-editable prediction data and emits events on change.
 */
export class PredictionState {
    constructor(data) {
        this.data = data;

        // OEVK predictions: Map<oevkId, Array<{candidateId, coalitionCode, pct}>>
        this.oevkPredictions = new Map();

        // National list votes: Map<coalitionCode, {domestic: number, postal: number}>
        this.listVotes = new Map();

        // Turnout percentage
        this.turnoutPct = 65.0;

        // Initialize with defaults
        this._initDefaults();
    }

    _initDefaults() {
        this._initListVotes();
        this._initOevkPredictions();
    }

    /**
     * Initialize list votes with estimates based on 2022 national results + turnout.
     */
    _initListVotes() {
        const domesticVoters = this.data.nationalTotals.domesticVoters || 8000000;
        const postalVoters = this.data.nationalTotals.postalVoters || 0;
        const totalDomesticVotes = Math.round(domesticVoters * this.turnoutPct / 100);

        // Estimated 2026 national list % based on 2022 + expected shifts
        const estimates = {
            'FIDESZ-KDNP': 44,
            'FIDESZ': 44,
            'TISZA': 32,
            'DK': 5,
            'Mi Hazánk': 7,
            'MKKP': 3,
            'MSZP': 1.5,
            'Jobbik': 1,
            'LMP – Zöldek': 0.5,
        };

        let assignedPct = 0;
        const unmatched = [];

        for (const [code, list] of this.data.partyListMap) {
            const coalition = this.data.coalitionMap.get(code);
            const name = coalition ? (coalition.shortName || coalition.name) : '';

            let pct = null;
            for (const [key, val] of Object.entries(estimates)) {
                if (name.toUpperCase().includes(key.toUpperCase())) {
                    pct = val;
                    break;
                }
            }

            if (pct != null) {
                this.listVotes.set(code, {
                    domestic: Math.round(totalDomesticVotes * pct / 100),
                    postal: Math.round(postalVoters * pct / 100),
                });
                assignedPct += pct;
            } else {
                unmatched.push(code);
            }
        }

        // Distribute remaining % equally among unmatched lists
        const remainingPct = Math.max(0, 100 - assignedPct);
        const eachPct = unmatched.length > 0 ? remainingPct / unmatched.length : 0;
        for (const code of unmatched) {
            this.listVotes.set(code, {
                domestic: Math.round(totalDomesticVotes * eachPct / 100),
                postal: Math.round(postalVoters * eachPct / 100),
            });
        }
    }

    /**
     * Initialize OEVK predictions from 2022 results with party mapping.
     */
    _initOevkPredictions() {
        for (const oevk of this.data.oevks) {
            const candidates = this.data.candidatesByOevk.get(oevk.id) || [];
            const prev = this.data.prevResultsMap.get(oevk.id);

            const preds = candidates.map(c => {
                const coalition = this.data.coalitionMap.get(c.coalitionCode);
                const coalitionName = coalition ? (coalition.shortName || coalition.name) : '';

                let defaultPct = 0;
                if (prev && prev.results.length > 0) {
                    defaultPct = this._estimateFromPrev(coalitionName, prev.results, candidates.length);
                }

                return {
                    candidateId: c.id,
                    coalitionCode: c.coalitionCode,
                    name: c.name,
                    coalitionName,
                    pct: Math.max(0, defaultPct),
                    isManuallySet: false,
                };
            });

            this._normalizeOevk(preds);
            this.oevkPredictions.set(oevk.id, preds);
        }
    }

    /**
     * Estimate a candidate's % from 2022 results based on party mapping.
     */
    _estimateFromPrev(coalitionName, prevResults, candidateCount) {
        const upper = coalitionName.toUpperCase();

        for (const prev of prevResults) {
            const prevUpper = (prev.coalition || '').toUpperCase();

            if (upper.includes('FIDESZ') && prevUpper.includes('FIDESZ')) {
                return prev.pct;
            }
            if (upper.includes('TISZA') && (
                prevUpper.includes('EGYSÉGBEN') ||
                prevUpper.includes('DK-JOBBIK') ||
                prevUpper.includes('ÖSSZEFOGÁS') ||
                prevUpper.includes('EGYSÉG')
            )) {
                return prev.pct * 0.85;
            }
            if (upper.includes('HAZÁNK') && prevUpper.includes('HAZÁNK')) {
                return prev.pct;
            }
            if (upper.includes('DK') && !upper.includes('KDNP') && (
                prevUpper.includes('EGYSÉGBEN') ||
                prevUpper.includes('DK-JOBBIK')
            )) {
                return prev.pct * 0.08;
            }
            if (upper.includes('MKKP') && prevUpper.includes('MKKP')) {
                return prev.pct;
            }
        }

        return candidateCount > 5 ? 1.0 : 2.0;
    }

    /**
     * Normalize OEVK predictions so percentages sum to 100.
     */
    _normalizeOevk(preds) {
        if (preds.length === 0) return;
        const sum = preds.reduce((s, p) => s + p.pct, 0);
        if (sum <= 0) {
            const each = 100 / preds.length;
            preds.forEach(p => { p.pct = each; });
            return;
        }
        if (Math.abs(sum - 100) > 0.1) {
            const factor = 100 / sum;
            preds.forEach(p => { p.pct = p.pct * factor; });
        }
    }

    // === Setters (trigger recalculation) ===

    setTurnout(pct) {
        this.turnoutPct = Math.max(0, Math.min(100, pct));
        bus.emit('prediction-changed', { type: 'turnout' });
    }

    setCandidatePct(oevkId, candidateId, pct) {
        const preds = this.oevkPredictions.get(oevkId);
        if (!preds) return;

        const candidate = preds.find(p => p.candidateId === candidateId);
        if (!candidate) return;

        // Clamp to 0-100
        candidate.pct = Math.max(0, Math.min(100, pct));
        candidate.isManuallySet = true;

        // Cap: if manual total > 100, scale down the latest entry to fit
        const manualEntries = preds.filter(p => p.isManuallySet);
        const manualSum = manualEntries.reduce((s, p) => s + p.pct, 0);
        if (manualSum > 100) {
            // Reduce the just-edited candidate so manual total = 100
            candidate.pct = Math.max(0, candidate.pct - (manualSum - 100));
        }

        this._redistributeOevk(oevkId);
        bus.emit('prediction-changed', { type: 'oevk', oevkId });
    }

    setListVotes(coalitionCode, type, amount) {
        const entry = this.listVotes.get(coalitionCode);
        if (!entry) {
            this.listVotes.set(coalitionCode, { domestic: 0, postal: 0 });
        }
        this.listVotes.get(coalitionCode)[type] = Math.max(0, Math.round(amount));
        bus.emit('prediction-changed', { type: 'list' });
    }

    /**
     * Redistribute percentages in an OEVK after manual edit.
     * Only adjusts non-manually-set candidates.
     */
    _redistributeOevk(oevkId) {
        const preds = this.oevkPredictions.get(oevkId);
        if (!preds) return;

        const manualSum = preds.filter(p => p.isManuallySet).reduce((s, p) => s + p.pct, 0);
        const remaining = Math.max(0, 100 - manualSum);
        const autoEntries = preds.filter(p => !p.isManuallySet);

        if (autoEntries.length === 0) return;

        const autoSum = autoEntries.reduce((s, p) => s + p.pct, 0);
        if (autoSum <= 0) {
            const each = remaining / autoEntries.length;
            autoEntries.forEach(p => { p.pct = each; });
        } else {
            const factor = remaining / autoSum;
            autoEntries.forEach(p => { p.pct = Math.max(0, p.pct * factor); });
        }
    }

    /**
     * Reset all predictions to zero.
     */
    resetAll() {
        for (const [oevkId, preds] of this.oevkPredictions) {
            for (const p of preds) {
                p.pct = 0;
                p.isManuallySet = false;
            }
        }
        for (const [code, entry] of this.listVotes) {
            entry.domestic = 0;
            entry.postal = 0;
        }
        this.turnoutPct = 65.0;
        bus.emit('prediction-changed', { type: 'all' });
    }

    /**
     * Re-initialize OEVK predictions from 2022 results.
     * Used before applying polling swing to ensure a valid base.
     */
    reinitOevkPredictions() {
        this._initOevkPredictions();
    }

    // === Getters ===

    getOevkResults(oevkId) {
        const preds = this.oevkPredictions.get(oevkId);
        if (!preds) return [];
        return preds;
    }

    /**
     * Get all OEVK results converted to absolute votes.
     */
    getAllOevkVotes() {
        const result = new Map();
        for (const [oevkId, preds] of this.oevkPredictions) {
            const oevk = this.data.oevkMap.get(oevkId);
            const totalVoters = oevk ? oevk.voters : 70000;
            result.set(oevkId, pctToVotes(preds, totalVoters, this.turnoutPct));
        }
        return result;
    }

    getDomesticListVotes() {
        const result = new Map();
        for (const [code, entry] of this.listVotes) {
            result.set(code, entry.domestic);
        }
        return result;
    }

    getPostalListVotes() {
        const result = new Map();
        for (const [code, entry] of this.listVotes) {
            result.set(code, entry.postal);
        }
        return result;
    }

    getTotalVoters() {
        const totals = this.data.nationalTotals;
        return Math.round((totals.domesticVoters || 0) * this.turnoutPct / 100);
    }

    /**
     * Bulk update from polling auto-fill.
     */
    applyPollingData(oevkPredictions, listVotePcts) {
        for (const [oevkId, preds] of oevkPredictions) {
            this.oevkPredictions.set(oevkId, preds.map(p => ({
                ...p,
                isManuallySet: false,
            })));
        }

        const totalDomestic = this.getTotalVoters();
        const totalPostal = this.data.nationalTotals.postalVoters || 0;

        for (const [code, pct] of listVotePcts) {
            this.listVotes.set(code, {
                domestic: Math.round(totalDomestic * pct / 100),
                postal: Math.round(totalPostal * pct / 100),
            });
        }

        bus.emit('prediction-changed', { type: 'all' });
    }
}
