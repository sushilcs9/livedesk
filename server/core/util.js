import { createHash } from 'node:crypto';

export const nowIso = () => new Date().toISOString();

export function hashOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export function log(level, msg, extra = {}) {
  const line = { t: nowIso(), level, msg, ...extra };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

const PARTY_MAP = [
  [/^(democrat|democratic|dem|d|dfl|democratic-farmer-labor)/i, 'DEM'],
  [/^(republican|rep|r|gop)/i, 'REP'],
  [/^(independent|ind|i|no party|nonpartisan|unaffiliated|npa)/i, 'IND'],
  [/^(libertarian|lib|l)$/i, 'LIB'],
  [/^libertarian/i, 'LIB'],
  [/^(green|grn)/i, 'GRN'],
  [/^(yes)$/i, 'YES'],
  [/^(no)$/i, 'NO'],
];

/** Map a provider's party string to a stable code. Unknown parties keep their label under OTH. */
export function normalizeParty(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { code: 'OTH', label: 'Unknown' };
  for (const [re, code] of PARTY_MAP) if (re.test(s)) return { code, label: s };
  return { code: 'OTH', label: s };
}

export const US_STATES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',
  DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',
  KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
  MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',
  PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',
  VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'
};

export const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);

/** fetch with timeout, conditional-request headers and a polite User-Agent. */
export async function politeFetch(url, { etag, lastModified, timeoutMs = 15000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const h = { 'User-Agent': process.env.LIVEDESK_USER_AGENT || 'LiveDesk/0.1 (election results aggregator)', Accept: 'application/json', ...headers };
    if (etag) h['If-None-Match'] = etag;
    if (lastModified) h['If-Modified-Since'] = lastModified;
    const res = await fetch(url, { headers: h, signal: ctrl.signal });
    if (res.status === 304) return { notModified: true, status: 304 };
    if (!res.ok) { const e = new Error(`HTTP ${res.status} for ${url}`); e.status = res.status; throw e; }
    const body = await res.json();
    return { body, status: res.status, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
  } finally { clearTimeout(timer); }
}
