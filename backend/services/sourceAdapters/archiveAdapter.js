import { log } from '../../utils/logger.js';

const INTERNET_ARCHIVE_HOST = 'https://archive.org';
const ARCHIVE_SEARCH_ENDPOINT = `${INTERNET_ARCHIVE_HOST}/advancedsearch.php`;
const ARCHIVE_METADATA_ENDPOINT = `${INTERNET_ARCHIVE_HOST}/metadata`;
const ARCHIVE_TIMEOUT_MS = 1500;
const ARCHIVE_SEARCH_FIELDS = ['identifier', 'title', 'creator', 'licenseurl', 'publicdate'];
const FORMAT_PRIORITY = ['txt', 'epub', 'pdf'];

const withTimeout = async (url, { timeoutMs = ARCHIVE_TIMEOUT_MS } = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const safeJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const asString = (value) => String(value || '').trim();

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
};

const normalizeCreator = (value) => {
  if (Array.isArray(value)) {
    return asString(value[0]) || 'Unknown author';
  }
  return asString(value) || 'Unknown author';
};

export const detectArchivePublicDomain = ({ licenseurl, rights } = {}) => {
  const normalizedLicense = asArray(licenseurl).map((value) => asString(value).toLowerCase()).join(' ');
  const normalizedRights = asArray(rights).map((value) => asString(value).toLowerCase()).join(' ');

  return normalizedLicense.includes('publicdomain')
    || normalizedLicense.includes('creativecommons.org/publicdomain')
    || normalizedRights === 'public domain'
    || normalizedRights.includes('no known copyright')
    || normalizedRights.includes('not in copyright');
};

const detectFileFormat = (fileName) => {
  const raw = asString(fileName).toLowerCase();
  if (!raw) return null;
  if (raw.endsWith('.txt')) return 'txt';
  if (raw.endsWith('.epub')) return 'epub';
  if (raw.endsWith('.pdf')) return 'pdf';
  return null;
};

export const normalizeArchiveSearchDoc = (doc = {}) => {
  const identifier = asString(doc?.identifier);
  if (!identifier) return null;

  const title = asString(doc?.title) || identifier;
  const author = normalizeCreator(doc?.creator);
  const isPublicDomain = detectArchivePublicDomain({ licenseurl: doc?.licenseurl });

  return {
    id: identifier,
    title,
    author,
    source: 'archive',
    cover: `${INTERNET_ARCHIVE_HOST}/services/img/${encodeURIComponent(identifier)}`,
    isPublicDomain,
    readable: false,
    downloadUrl: null,
    formats: [],
    publicdate: asString(doc?.publicdate) || null,
    licenseurl: asString(doc?.licenseurl) || null,
  };
};

export const searchArchiveBooks = async (query, { maxResults = 18, timeoutMs = ARCHIVE_TIMEOUT_MS } = {}) => {
  const term = asString(query);
  if (!term) return [];

  const params = new URLSearchParams();
  params.set('q', `mediatype:texts AND (title:(${term}) OR creator:(${term}))`);
  params.set('rows', String(maxResults));
  params.set('page', '1');
  params.set('output', 'json');
  ARCHIVE_SEARCH_FIELDS.forEach((field) => params.append('fl[]', field));

  const response = await withTimeout(`${ARCHIVE_SEARCH_ENDPOINT}?${params.toString()}`, { timeoutMs });
  if (!response.ok) {
    throw new Error(`Archive search failed with ${response.status}`);
  }

  const payload = await safeJson(response);
  const docs = Array.isArray(payload?.response?.docs) ? payload.response.docs : [];
  return docs.map((doc) => normalizeArchiveSearchDoc(doc)).filter(Boolean);
};

export const fetchArchiveMetadata = async (identifier, { timeoutMs = ARCHIVE_TIMEOUT_MS } = {}) => {
  const id = asString(identifier);
  if (!id) return null;

  const response = await withTimeout(`${ARCHIVE_METADATA_ENDPOINT}/${encodeURIComponent(id)}`, { timeoutMs });
  if (!response.ok) {
    throw new Error(`Archive metadata failed with ${response.status}`);
  }

  return safeJson(response);
};

export const enrichArchiveReadability = async (book, { timeoutMs = ARCHIVE_TIMEOUT_MS } = {}) => {
  const identifier = asString(book?.id || book?.sourceId);
  if (!identifier) return { ...book, readable: false, formats: [], downloadUrl: null };

  const metadata = await fetchArchiveMetadata(identifier, { timeoutMs });
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  const rights = metadata?.metadata?.rights;
  const licenseurl = metadata?.metadata?.licenseurl || book?.licenseurl;

  const isPublicDomain = detectArchivePublicDomain({ licenseurl, rights });
  if (!isPublicDomain) {
    return {
      ...book,
      isPublicDomain: false,
      readable: false,
      formats: [],
      downloadUrl: null,
      metadata,
    };
  }

  const discoveredFormats = [];
  const downloadByFormat = {};
  for (const file of files) {
    const format = detectFileFormat(file?.name);
    if (!format || discoveredFormats.includes(format)) continue;
    discoveredFormats.push(format);
    downloadByFormat[format] = `${INTERNET_ARCHIVE_HOST}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(asString(file?.name))}`;
  }

  const formats = FORMAT_PRIORITY.filter((format) => discoveredFormats.includes(format));
  const downloadUrl = formats.length > 0 ? downloadByFormat[formats[0]] : null;

  return {
    ...book,
    isPublicDomain: true,
    readable: Boolean(downloadUrl),
    formats,
    downloadUrl,
    metadata,
  };
};

export const getArchiveDetailsUrl = (identifier) => `${INTERNET_ARCHIVE_HOST}/details/${encodeURIComponent(asString(identifier))}`;

export const logArchiveMetric = (name, value = 1) => {
  log(`[ARCHIVE][METRIC] ${name}=${value}`);
};
