'use strict';
/**
 * Commuting-region helper for Jole buyer site ties. Pure: callers pass place
 * records ({ state, name, lat, lon }) loaded from the US Census place
 * gazetteer (not stored in the repo).
 *
 * REGION = places within `radiusMiles` (default 50) of the hiring site. Phase 5
 * REGION examples were 10-70 miles apart (Hazen-Beulah ND, Peoria-Manito IL,
 * Lake Charles-Cameron LA, Odessa TX-Eunice NM).
 */
const EARTH_MILES = 3958.8;
const SUFFIX = / (city|town|village|borough|CDP|municipality|city and borough|urban county|consolidated government.*|metro government.*|unified government.*)$/i;

function haversineMiles(a, b) {
  const rad = deg => deg * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.sqrt(h));
}

const placeName = raw => String(raw || '').replace(SUFFIX, '').trim();
const key = value => String(value || '').toLowerCase().replace(/\bsaint\b/g, 'st').replace(/[^a-z]+/g, ' ').trim();

/** The gazetteer place for "City, ST", or null. */
function findPlace(places, { city, state }) {
  const wanted = key(city);
  const inState = places.filter(place => place.state === state);
  return inState.find(place => key(placeName(place.name)) === wanted)
    // Consolidated city-counties: "Macon-Bibb County", "Louisville/Jefferson County metro government".
    || inState.find(place => /^[^-/]+[-/]/.test(place.name) && key(place.name.split(/[-/]/)[0]) === wanted)
    || null;
}

/** Other places within the radius of `site`, nearest first, as { name, state, miles }. */
function nearbyPlaces(site, places, { radiusMiles = 50, max = 50 } = {}) {
  return places
    .map(place => ({ name: placeName(place.name), state: place.state, miles: haversineMiles(site, place) }))
    .filter(place => place.miles > 0.5 && place.miles <= radiusMiles)
    .sort((a, b) => a.miles - b.miles)
    .slice(0, max);
}

module.exports = { haversineMiles, placeName, findPlace, nearbyPlaces };
