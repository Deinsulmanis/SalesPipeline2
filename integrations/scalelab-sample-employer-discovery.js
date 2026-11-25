'use strict';
// New-employer discovery for thin states (sample employer list). PURE helpers:
// the main industrial cities per state, and the filter that keeps direct
// employers only (no staffing agencies, no national retail, no ScaleLab
// prospects). Every candidate is still verified by a per-company posting check
// in the state before it is saved.

// Up to four main industrial/metro cities per state, largest hiring markets first.
const MAIN_CITIES = Object.freeze({
  AL: ['Birmingham', 'Huntsville', 'Mobile', 'Montgomery'], AK: ['Anchorage'], AZ: ['Phoenix', 'Tucson', 'Mesa', 'Chandler'],
  AR: ['Little Rock', 'Fort Smith', 'Fayetteville', 'Jonesboro'], CA: ['Los Angeles', 'Fresno', 'Sacramento', 'San Diego'],
  CO: ['Denver', 'Colorado Springs', 'Aurora', 'Greeley'], CT: ['Hartford', 'New Haven', 'Bridgeport', 'Waterbury'],
  DE: ['Wilmington', 'Newark', 'Dover'], DC: ['Washington'], FL: ['Jacksonville', 'Tampa', 'Orlando', 'Miami'],
  GA: ['Atlanta', 'Savannah', 'Augusta', 'Macon'], HI: ['Honolulu'], ID: ['Boise', 'Nampa', 'Idaho Falls', 'Pocatello'],
  IL: ['Chicago', 'Rockford', 'Peoria', 'Joliet'], IN: ['Indianapolis', 'Fort Wayne', 'Elkhart', 'Evansville'],
  IA: ['Des Moines', 'Cedar Rapids', 'Davenport', 'Waterloo'], KS: ['Wichita', 'Kansas City', 'Topeka', 'Olathe'],
  KY: ['Louisville', 'Lexington', 'Bowling Green', 'Owensboro'], LA: ['Baton Rouge', 'New Orleans', 'Lafayette', 'Shreveport'],
  ME: ['Portland', 'Bangor', 'Lewiston'], MD: ['Baltimore', 'Frederick', 'Hagerstown', 'Salisbury'],
  MA: ['Worcester', 'Springfield', 'Boston', 'Lowell'], MI: ['Detroit', 'Grand Rapids', 'Lansing', 'Kalamazoo'],
  MN: ['Minneapolis', 'Saint Paul', 'Rochester', 'Duluth'], MS: ['Jackson', 'Gulfport', 'Tupelo', 'Hattiesburg'],
  MO: ['Kansas City', 'St. Louis', 'Springfield', 'Joplin'], MT: ['Billings', 'Missoula', 'Great Falls'],
  NE: ['Omaha', 'Lincoln', 'Grand Island'], NV: ['Las Vegas', 'Reno', 'Henderson', 'Sparks'],
  NH: ['Manchester', 'Nashua', 'Concord'], NJ: ['Newark', 'Edison', 'Trenton', 'Camden'],
  NM: ['Albuquerque', 'Las Cruces', 'Santa Fe', 'Farmington'], NY: ['Buffalo', 'Rochester', 'Syracuse', 'Albany'],
  NC: ['Charlotte', 'Greensboro', 'Raleigh', 'Winston-Salem'], ND: ['Fargo', 'Bismarck', 'Grand Forks'],
  OH: ['Columbus', 'Cleveland', 'Cincinnati', 'Toledo'], OK: ['Oklahoma City', 'Tulsa', 'Norman', 'Enid'],
  OR: ['Portland', 'Salem', 'Eugene', 'Medford'], PA: ['Pittsburgh', 'Philadelphia', 'Allentown', 'Harrisburg'],
  RI: ['Providence', 'Warwick', 'Cranston'], SC: ['Greenville', 'Columbia', 'Charleston', 'Spartanburg'],
  SD: ['Sioux Falls', 'Rapid City'], TN: ['Nashville', 'Memphis', 'Knoxville', 'Chattanooga'],
  TX: ['Houston', 'Dallas', 'San Antonio', 'Fort Worth'], UT: ['Salt Lake City', 'Ogden', 'Provo', 'Logan'],
  VT: ['Burlington', 'Rutland'], VA: ['Richmond', 'Norfolk', 'Roanoke', 'Chesapeake'],
  WA: ['Seattle', 'Tacoma', 'Spokane', 'Everett'], WV: ['Charleston', 'Huntington', 'Morgantown', 'Parkersburg'],
  WI: ['Milwaukee', 'Madison', 'Green Bay', 'Appleton'], WY: ['Cheyenne', 'Casper'],
});

const STAFFING = /staffing|personnel|recruit|workforce|employment|temporar|\btemps?\b|manpower|talent|placement|labor (?:ready|finders|source|solutions|services)|\bhr\b|careers?\b|\bjobs?\b|outsourc|search group|people(?:ready| source)/i;
const NATIONAL_RETAIL = /walmart|\btarget\b|home depot|lowe'?s|costco|kroger|amazon|best buy|dollar (?:general|tree)|family dollar|tractor supply|walgreens|\bcvs\b|publix|\baldi\b|meijer|sam'?s club|\bbj'?s\b|autozone|o'?reilly|advance auto|7-eleven|wawa|sheetz|menards|ace hardware|harbor freight|ikea|macy'?s|kohl'?s|\bheb\b|h-e-b|safeway|albertsons|wegmans|\bross\b|tj ?maxx|marshalls|petsmart|petco|staples|office depot/i;
const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

function excludedReason(row, { knownDomains = new Set(), agencyDomains = new Set() } = {}) {
  const name = String(row.company_name || row.company || '').trim();
  const domain = String(row.company_domain || row.domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!name || !DOMAIN.test(domain)) return 'no_domain';
  if (knownDomains.has(domain)) return 'already_in_pool';
  if (agencyDomains.has(domain)) return 'scalelab_prospect';
  if (STAFFING.test(name) || STAFFING.test(domain)) return 'staffing_agency';
  if (NATIONAL_RETAIL.test(name) || NATIONAL_RETAIL.test(domain)) return 'national_retail';
  return null;
}

/** Grouped search rows -> direct-employer candidates, most open roles first. */
function directEmployerCandidates(rows = [], options = {}) {
  const seen = new Set();
  const out = [];
  for (const row of [...rows].sort((a, b) => (Number(b.open_role_count ?? b.role_count) || 0) - (Number(a.open_role_count ?? a.role_count) || 0))) {
    if (excludedReason(row, options)) continue;
    const domain = String(row.company_domain || row.domain).trim().toLowerCase().replace(/^www\./, '');
    if (seen.has(domain)) continue;
    seen.add(domain);
    out.push({ domain, company: String(row.company_name || row.company).trim(), roleCount: Number(row.open_role_count ?? row.role_count) || 0 });
  }
  return out;
}

module.exports = { MAIN_CITIES, excludedReason, directEmployerCandidates };
