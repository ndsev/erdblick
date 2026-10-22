/** Parses decimal or degree-minute-second WGS84 text, with an optional tile level. */
export function parseWgs84CoordinateString(coordinateString: string, isLonLat = false): { lat: number; lon: number; level: number } | undefined {
    let lon = 0;
    let lat = 0;
    let level = 0;
    let isMatched = false;
    coordinateString = coordinateString.trim();

    // WGS (decimal)
    let exp = /^[^\d-]*(-?\d+(?:\.\d*)?)[^\d-]+(-?\d+(?:\.\d*)?)[^\d\.]*(\d+)?[^\d]*$/g;
    let matches = [...coordinateString.matchAll(exp)];
    if (matches.length > 0) {
        let matchResults = matches[0];
        if (matchResults.length >= 3) {
            if (isLonLat) {
                lon = Number(matchResults[1]);
                lat = Number(matchResults[2]);
            } else {
                lon = Number(matchResults[2]);
                lat = Number(matchResults[1]);
            }

            if (matchResults.length >= 4 && matchResults[3] !== undefined) {
                // Zoom level provided.
                level = Math.max(1, Math.min(Number(matchResults[3].toString()), 14));
            }
            isMatched = true;
        }
    }

    // WGS (degree)
    if (!isMatched) {
        if (isLonLat) {
            exp = /((?:[0-9]{0,1}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([WE])\s*((?:[0-9]{0,2}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([NS])[^\d\.]*(\d+)?[^\d]*$/g
        } else {
            exp = /((?:[0-9]{0,2}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([NS])\s*((?:[0-9]{0,1}[0-9])(?:.{1}[0-9]*)?)[º°]([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([WE])[^\d\.]*(\d+)?[^\d]*$/g;
        }
        matches = [...coordinateString.matchAll(exp)];
    }
    if (!isMatched && matches.length > 0) {
        let matchResults = matches[0];
        if (matchResults.length >= 9) {
            let degreeLon = isLonLat ? Number(matchResults[1]) : Number(matchResults[5]);
            let minutesLon = isLonLat ? Number(matchResults[2]) : Number(matchResults[6]);
            let secondsLon = isLonLat ? Number(matchResults[3]) : Number(matchResults[7]);
            let degreeLat = isLonLat ? Number(matchResults[5]) : Number(matchResults[1]);
            let minutesLat = isLonLat ? Number(matchResults[6]) : Number(matchResults[2]);
            let secondsLat = isLonLat ? Number(matchResults[7]) : Number(matchResults[3]);

            lat = degreeLat + (minutesLat * 60.0 + secondsLat) / 3600.0;
            if (matchResults[isLonLat ? 8 : 4][0] === 'S') {
                lat = -lat;
            }

            lon = degreeLon + (minutesLon * 60.0 + secondsLon) / 3600.0;
            if (matchResults[isLonLat ? 4 : 8][0] === 'W') {
                lon = -lon;
            }

            if (matchResults.length >= 10 && matchResults[9] !== undefined) {
                // Zoom level provided.
                level = Math.max(1, Math.min(Number(matchResults[9].toString()), 14));
            }

            isMatched = true;
        }
    }

    return isMatched && Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
        ? { lat, lon, level } : undefined;

}
