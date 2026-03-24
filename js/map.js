// === SVG Map rendering ===

const SVG_NS = 'http://www.w3.org/2000/svg';

let _projection = null;

/**
 * Calculate projection parameters from all polygon data.
 * Simple Mercator with cosine correction for Hungary's latitude.
 */
function buildProjection(oevkPolygons, countyPolygons, viewWidth = 1000, viewHeight = 500) {
    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;

    const allPolygons = [
        ...oevkPolygons.map(p => p.polygon),
        ...countyPolygons.map(p => p.polygon),
    ];

    for (const poly of allPolygons) {
        for (const [lat, lon] of poly) {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
        }
    }

    const midLat = (minLat + maxLat) / 2;
    const cosCorrection = Math.cos(midLat * Math.PI / 180);

    const lonRange = maxLon - minLon;
    const latRange = maxLat - minLat;

    const padding = 20;
    const usableWidth = viewWidth - 2 * padding;
    const usableHeight = viewHeight - 2 * padding;

    const scaleX = usableWidth / (lonRange * cosCorrection);
    const scaleY = usableHeight / latRange;
    const scale = Math.min(scaleX, scaleY);

    // Center the map
    const mapWidth = lonRange * cosCorrection * scale;
    const mapHeight = latRange * scale;
    const offsetX = padding + (usableWidth - mapWidth) / 2;
    const offsetY = padding + (usableHeight - mapHeight) / 2;

    return {
        minLat, maxLat, minLon, maxLon,
        cosCorrection, scale,
        offsetX, offsetY,
        project(lat, lon) {
            const x = (lon - minLon) * cosCorrection * scale + offsetX;
            const y = (maxLat - lat) * scale + offsetY;
            return [x, y];
        }
    };
}

/**
 * Convert a polygon (array of [lat,lon]) to SVG path data string.
 */
function polygonToPath(polygon, proj) {
    if (polygon.length === 0) return '';
    const points = polygon.map(([lat, lon]) => proj.project(lat, lon));
    return 'M' + points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z';
}

/**
 * Render the map: OEVK polygons + county borders.
 *
 * @param {Object} data - loaded data from data.js
 * @param {Function} getColor - function(oevkId) => hex color
 * @param {Function} onClick - function(oevkId)
 * @param {Function} onHover - function(oevkId, event) or null for mouseout
 */
export function renderMap(data, getColor, onClick, onHover) {
    const { oevkPolygons, countyPolygons } = data;

    _projection = buildProjection(oevkPolygons, countyPolygons);

    const oevkGroup = document.getElementById('map-oevk');
    const countyGroup = document.getElementById('map-counties');

    // Clear existing
    oevkGroup.innerHTML = '';
    countyGroup.innerHTML = '';

    // Render OEVK polygons
    for (const oevk of oevkPolygons) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', polygonToPath(oevk.polygon, _projection));
        path.setAttribute('data-id', oevk.id);
        path.setAttribute('fill', getColor(oevk.id) || '#444');

        path.addEventListener('click', () => onClick(oevk.id));
        path.addEventListener('mouseenter', (e) => onHover(oevk.id, e));
        path.addEventListener('mousemove', (e) => onHover(oevk.id, e));
        path.addEventListener('mouseleave', () => onHover(null, null));

        oevkGroup.appendChild(path);
    }

    // Render county borders
    for (const county of countyPolygons) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', polygonToPath(county.polygon, _projection));
        countyGroup.appendChild(path);
    }
}

/**
 * Update a single OEVK's color on the map.
 */
export function updateOevkColor(oevkId, color) {
    const path = document.querySelector(`#map-oevk path[data-id="${oevkId}"]`);
    if (path) path.setAttribute('fill', color);
}

/**
 * Update all OEVK colors.
 * @param {Function} getColor - function(oevkId) => hex color
 */
export function updateAllColors(getColor) {
    const paths = document.querySelectorAll('#map-oevk path');
    for (const path of paths) {
        const id = path.getAttribute('data-id');
        path.setAttribute('fill', getColor(id) || '#444');
    }
}

/**
 * Show/hide/move the map tooltip.
 */
export function showTooltip(oevkId, event, data, predictionState) {
    const tooltip = document.getElementById('map-tooltip');
    if (!oevkId || !event) {
        tooltip.classList.add('hidden');
        return;
    }

    const oevk = data.oevkMap.get(oevkId);
    const candidates = predictionState.getOevkResults(oevkId);
    const winner = candidates && candidates.length > 0
        ? [...candidates].sort((a, b) => b.pct - a.pct)[0]
        : null;

    const coalition = winner ? data.coalitionMap.get(winner.coalitionCode) : null;

    tooltip.innerHTML = `
        <div class="tt-name">${oevk ? oevk.name : oevkId}</div>
        ${winner ? `<div class="tt-winner">${coalition ? coalition.shortName || coalition.name : '?'} – ${winner.pct.toFixed(1)}%</div>` : '<div>Nincs adat</div>'}
    `;

    const mapRect = document.querySelector('.map-container').getBoundingClientRect();
    tooltip.style.left = (event.clientX - mapRect.left + 10) + 'px';
    tooltip.style.top = (event.clientY - mapRect.top - 10) + 'px';
    tooltip.classList.remove('hidden');
}
