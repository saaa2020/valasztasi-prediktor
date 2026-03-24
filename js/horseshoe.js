// === Parliament horseshoe diagram (SVG) ===

const SVG_NS = 'http://www.w3.org/2000/svg';
const TOTAL_SEATS = 199;
const MAJORITY = 100; // Simple majority
const SUPERMAJORITY = 133; // 2/3 supermajority

// Row configuration: seats per row from inner to outer arc
const ROWS = [25, 29, 33, 37, 38, 37];
// ROWS sum = 199

// Political spectrum order (left to right on horseshoe)
const SPECTRUM_ORDER = [
    'DK', 'MSZP', 'LMP', 'Párbeszéd', 'Momentum',
    'TISZA',
    'MKKP',
    'Mi Hazánk', 'MI HAZÁNK',
    'FIDESZ', 'KDNP', 'FIDESZ-KDNP',
];

/**
 * Render the horseshoe diagram.
 *
 * @param {Map<number, number>} totalSeats - coalitionCode -> seats
 * @param {Map<number, Object>} coalitionMap - code -> {name, shortName, color}
 */
export function renderHorseshoe(totalSeats, coalitionMap) {
    const svg = document.getElementById('horseshoe-svg');
    const legend = document.getElementById('horseshoe-legend');
    svg.innerHTML = '';
    legend.innerHTML = '';

    // Build ordered seat array
    const seatList = buildSeatList(totalSeats, coalitionMap);

    // Calculate circle positions
    const cx = 300, cy = 310;
    const rInner = 120, rOuter = 280;
    const rStep = (rOuter - rInner) / (ROWS.length - 1);
    const circleRadius = 7;

    let seatIndex = 0;

    for (let row = 0; row < ROWS.length; row++) {
        const seatsInRow = ROWS[row];
        const r = rInner + row * rStep;

        for (let i = 0; i < seatsInRow; i++) {
            // Angle from π (left) to 0 (right), evenly spaced with padding
            const anglePad = 0.08;
            const angle = Math.PI - anglePad - (Math.PI - 2 * anglePad) * i / (seatsInRow - 1);

            const x = cx + r * Math.cos(angle);
            const y = cy - r * Math.sin(angle);

            const seat = seatList[seatIndex] || { color: '#333', name: '?' };

            const circle = document.createElementNS(SVG_NS, 'circle');
            circle.setAttribute('cx', x.toFixed(1));
            circle.setAttribute('cy', y.toFixed(1));
            circle.setAttribute('r', circleRadius);
            circle.setAttribute('fill', seat.color);
            circle.setAttribute('stroke', 'rgba(0,0,0,0.3)');
            circle.setAttribute('stroke-width', '0.5');

            // Tooltip on hover
            const title = document.createElementNS(SVG_NS, 'title');
            title.textContent = seat.name;
            circle.appendChild(title);

            svg.appendChild(circle);
            seatIndex++;
        }
    }

    // Center text: leading party + majority line
    const leadingEntry = [...totalSeats.entries()].sort((a, b) => b[1] - a[1])[0];
    if (leadingEntry) {
        const [code, seats] = leadingEntry;
        const coalition = coalitionMap.get(code);
        const name = coalition ? (coalition.shortName || coalition.name) : '?';

        // Seat count
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('x', cx);
        text.setAttribute('y', cy - 40);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', coalition ? coalition.color : '#fff');
        text.setAttribute('font-size', '36');
        text.setAttribute('font-weight', '700');
        text.textContent = seats;
        svg.appendChild(text);

        // Party name
        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('x', cx);
        label.setAttribute('y', cy - 10);
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('fill', '#e0e0e0');
        label.setAttribute('font-size', '14');
        label.textContent = name;
        svg.appendChild(label);

        // Majority info
        const majorityText = document.createElementNS(SVG_NS, 'text');
        majorityText.setAttribute('x', cx);
        majorityText.setAttribute('y', cy + 12);
        majorityText.setAttribute('text-anchor', 'middle');
        majorityText.setAttribute('fill', '#a0a0b0');
        majorityText.setAttribute('font-size', '11');
        const status = seats >= SUPERMAJORITY ? '2/3 többség!' :
                       seats >= MAJORITY ? 'Egyszerű többség' :
                       `${MAJORITY - seats} mandátum kell a többséghez`;
        majorityText.textContent = status;
        svg.appendChild(majorityText);
    }

    // Legend
    const partySeats = [...totalSeats.entries()]
        .map(([code, seats]) => ({ code, seats, coalition: coalitionMap.get(code) }))
        .filter(p => p.seats > 0)
        .sort((a, b) => b.seats - a.seats);

    for (const { code, seats, coalition } of partySeats) {
        const item = document.createElement('div');
        item.className = 'legend-item';
        item.innerHTML = `
            <span class="legend-color" style="background:${coalition ? coalition.color : '#888'}"></span>
            <span>${coalition ? (coalition.shortName || coalition.name) : '?'}: <strong>${seats}</strong></span>
        `;
        legend.appendChild(item);
    }
}

/**
 * Build an ordered array of seats for rendering.
 * Seats are grouped by party and ordered by political spectrum (left→right).
 */
function buildSeatList(totalSeats, coalitionMap) {
    const entries = [...totalSeats.entries()]
        .map(([code, seats]) => {
            const coalition = coalitionMap.get(code);
            const name = coalition ? (coalition.shortName || coalition.name) : '?';
            const color = coalition ? coalition.color : '#888';
            const spectrumIndex = getSpectrumIndex(name);
            return { code, seats, name, color, spectrumIndex };
        })
        .sort((a, b) => a.spectrumIndex - b.spectrumIndex);

    const seatList = [];
    for (const entry of entries) {
        for (let i = 0; i < entry.seats; i++) {
            seatList.push({ color: entry.color, name: `${entry.name} (${entry.seats} mandátum)` });
        }
    }

    return seatList;
}

function getSpectrumIndex(name) {
    const upper = name.toUpperCase();
    for (let i = 0; i < SPECTRUM_ORDER.length; i++) {
        if (upper.includes(SPECTRUM_ORDER[i].toUpperCase())) return i;
    }
    return SPECTRUM_ORDER.length; // Unknown at the end
}
