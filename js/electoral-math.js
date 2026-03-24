// === Electoral math: fragment votes, D'Hondt, seat allocation ===

/**
 * Calculate fragment votes from OEVK results.
 *
 * @param {Map<string, Array<{coalitionCode: number, votes: number}>>} oevkResults
 *   Map of oevkId -> array of candidate results sorted by votes descending
 * @returns {Map<number, number>} coalitionCode -> total fragment votes
 */
export function calculateFragmentVotes(oevkResults) {
    const fragments = new Map();

    for (const [oevkId, candidates] of oevkResults) {
        if (!candidates || candidates.length === 0) continue;

        // Sort by votes descending
        const sorted = [...candidates].sort((a, b) => b.votes - a.votes);
        const winner = sorted[0];
        const secondPlace = sorted.length > 1 ? sorted[1] : null;

        for (let i = 0; i < sorted.length; i++) {
            const c = sorted[i];
            if (c.coalitionCode == null) continue; // Independent without list

            let fragmentVotes;
            if (i === 0) {
                // Winner: excess votes = winner votes - (second place votes + 1)
                const secondVotes = secondPlace ? secondPlace.votes : 0;
                fragmentVotes = Math.max(0, c.votes - secondVotes - 1);
            } else {
                // Loser: all votes are fragment votes
                fragmentVotes = c.votes;
            }

            fragments.set(
                c.coalitionCode,
                (fragments.get(c.coalitionCode) || 0) + fragmentVotes
            );
        }
    }

    return fragments;
}

/**
 * D'Hondt method for proportional seat allocation.
 *
 * @param {Map<number, number>} partyVotes - coalitionCode -> adjusted vote count
 * @param {number} totalSeats - seats to allocate
 * @returns {Map<number, number>} coalitionCode -> seats won
 */
export function dhondt(partyVotes, totalSeats) {
    const seats = new Map();
    const parties = [...partyVotes.entries()].filter(([_, v]) => v > 0);

    for (const [code] of parties) {
        seats.set(code, 0);
    }

    for (let s = 0; s < totalSeats; s++) {
        let bestCode = null;
        let bestQuotient = -1;

        for (const [code, votes] of parties) {
            const currentSeats = seats.get(code) || 0;
            const quotient = votes / (currentSeats + 1);
            if (quotient > bestQuotient) {
                bestQuotient = quotient;
                bestCode = code;
            }
        }

        if (bestCode != null) {
            seats.set(bestCode, (seats.get(bestCode) || 0) + 1);
        }
    }

    return seats;
}

/**
 * Apply threshold filter to party list votes.
 * Parties below their threshold are excluded.
 *
 * @param {Map<number, number>} listVotes - coalitionCode -> total list votes
 * @param {Map<number, {threshold: number}>} partyListMap - coalitionCode -> list info
 * @returns {Map<number, number>} filtered map with only above-threshold parties
 */
export function applyThreshold(listVotes, partyListMap) {
    const totalVotes = [...listVotes.values()].reduce((sum, v) => sum + v, 0);
    if (totalVotes === 0) return new Map();

    const filtered = new Map();
    for (const [code, votes] of listVotes) {
        const listInfo = partyListMap.get(code);
        const threshold = listInfo ? listInfo.threshold : 5;
        const pct = (votes / totalVotes) * 100;
        if (pct >= threshold) {
            filtered.set(code, votes);
        }
    }
    return filtered;
}

/**
 * Full seat allocation calculation.
 *
 * @param {Object} params
 * @param {Map<string, Array<{coalitionCode: number, votes: number}>>} params.oevkResults
 * @param {Map<number, number>} params.domesticListVotes - coalitionCode -> domestic list votes
 * @param {Map<number, number>} params.postalListVotes - coalitionCode -> postal list votes
 * @param {Map<number, {threshold: number}>} params.partyListMap
 * @returns {Object} Full allocation result
 */
export function calculateSeatAllocation({
    oevkResults,
    domesticListVotes,
    postalListVotes,
    partyListMap,
}) {
    const TOTAL_SEATS = 199;
    const OEVK_SEATS = 106;
    const LIST_SEATS = TOTAL_SEATS - OEVK_SEATS; // 93

    // 1. Count OEVK winners
    const oevkWinners = new Map(); // coalitionCode -> count
    const oevkWinnerByDistrict = new Map(); // oevkId -> coalitionCode

    for (const [oevkId, candidates] of oevkResults) {
        if (!candidates || candidates.length === 0) continue;
        const sorted = [...candidates].sort((a, b) => b.votes - a.votes);
        const winner = sorted[0];
        // Skip if all candidates have 0 votes (no valid winner)
        if (winner.votes <= 0) continue;
        if (winner.coalitionCode != null) {
            oevkWinners.set(winner.coalitionCode, (oevkWinners.get(winner.coalitionCode) || 0) + 1);
        }
        oevkWinnerByDistrict.set(oevkId, winner.coalitionCode);
    }

    // 2. Calculate fragment votes
    const fragmentVotes = calculateFragmentVotes(oevkResults);

    // 3. Combine list votes: domestic + postal + fragment votes
    const combinedListVotes = new Map();
    const allCodes = new Set([
        ...domesticListVotes.keys(),
        ...postalListVotes.keys(),
        ...fragmentVotes.keys(),
    ]);

    for (const code of allCodes) {
        // Only include parties that have a registered list
        if (!partyListMap.has(code)) continue;
        const domestic = domesticListVotes.get(code) || 0;
        const postal = postalListVotes.get(code) || 0;
        const fragment = fragmentVotes.get(code) || 0;
        combinedListVotes.set(code, domestic + postal + fragment);
    }

    // 4. Apply threshold
    const aboveThreshold = applyThreshold(combinedListVotes, partyListMap);

    // 5. D'Hondt allocation for list seats
    const listSeats = dhondt(aboveThreshold, LIST_SEATS);

    // 6. Combine OEVK + list seats
    const totalSeats = new Map();
    const allPartyCodes = new Set([...oevkWinners.keys(), ...listSeats.keys()]);
    for (const code of allPartyCodes) {
        totalSeats.set(code, (oevkWinners.get(code) || 0) + (listSeats.get(code) || 0));
    }

    return {
        oevkWinners,
        oevkWinnerByDistrict,
        fragmentVotes,
        combinedListVotes,
        aboveThreshold,
        listSeats,
        totalSeats,
        totalOevkSeats: OEVK_SEATS,
        totalListSeats: LIST_SEATS,
    };
}

/**
 * Convert user percentage inputs + turnout into absolute vote counts for an OEVK.
 *
 * @param {Array<{coalitionCode: number, pct: number}>} candidatePcts
 * @param {number} totalVoters - registered voters in this OEVK
 * @param {number} turnoutPct - turnout percentage (0-100)
 * @returns {Array<{coalitionCode: number, votes: number, pct: number}>}
 */
export function pctToVotes(candidatePcts, totalVoters, turnoutPct) {
    const totalVotes = Math.round(totalVoters * turnoutPct / 100);

    return candidatePcts.map(c => ({
        coalitionCode: c.coalitionCode,
        votes: Math.round(totalVotes * c.pct / 100),
        pct: c.pct,
    }));
}
