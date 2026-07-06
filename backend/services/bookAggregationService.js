import { log } from '../utils/logger.js';
import {
  enrichArchiveReadability,
  getArchiveDetailsUrl,
  logArchiveMetric,
  searchArchiveBooks,
} from './sourceAdapters/archiveAdapter.js';

const GUTENDEX_HOST = 'https://gutendex.com';
const OPEN_LIBRARY_HOST = 'https://openlibrary.org';
const GOOGLE_BOOKS_HOST = 'https://www.googleapis.com/books/v1/volumes';

const SOURCE_GUTENBERG = 'gutenberg';
const SOURCE_OPEN_LIBRARY = 'openlibrary';
const SOURCE_ARCHIVE = 'archive';
const SOURCE_INTERNET_ARCHIVE = 'internetarchive';
const SOURCE_GOOGLE_BOOKS = 'googlebooks';

const SEARCH_TIMEOUT_MS = 12000;
const READ_TIMEOUT_MS = 20000;

const withTimeout = async (url, { timeoutMs = SEARCH_TIMEOUT_MS } = {}) => {
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

const safeText = async (response) => {
  try {
    return await response.text();
  } catch {
    return '';
  }
};

const normalizeAuthor = (value) => {
  const trimmed = String(value || '').trim();
  return trimmed || 'Unknown author';
};

const normalizeTitle = (value, fallback = 'Untitled') => {
  const trimmed = String(value || '').trim();
  return trimmed || fallback;
};

const buildCoverFallback = (title) => `https://placehold.co/420x630?text=${encodeURIComponent(String(title || 'No Cover'))}`;

const toUnifiedBook = ({ source, sourceId, title, author, coverImage, extras = {} }) => ({
  id: `${source}:${sourceId}`,
  title: normalizeTitle(title),
  author: normalizeAuthor(author),
  coverImage: coverImage || buildCoverFallback(title),
  source,
  sourceId: String(sourceId),
  ...extras,
});

const toHtmlParagraphs = (text) => String(text || '')
  .split(/\n{2,}/)
  .map((block) => block.replace(/\n+/g, ' ').trim())
  .filter(Boolean)
  .map((block) => `<p>${block
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')}</p>`)
  .join('\n');

const textToSingleChapter = (text, fallbackTitle = 'Preview') => {
  const html = toHtmlParagraphs(text);
  if (!html) return [];
  return [{ index: 1, title: fallbackTitle, html }];
};

const uniqueById = (books = []) => {
  const map = new Map();
  for (const book of books) {
    if (!book?.id) continue;
    if (!map.has(book.id)) map.set(book.id, book);
  }
  return Array.from(map.values());
};

const runSourceSafely = async (label, action) => {
  const started = Date.now();
  try {
    const results = await action();
    const normalized = Array.isArray(results) ? results : [];
    log(`[BOOK][SEARCH] Source ${label} responded with ${normalized.length} results in ${Date.now() - started}ms`);
    return normalized;
  } catch (error) {
    console.warn(`[BOOK][SEARCH] Source ${label} failed:`, error?.message || error);
    return [];
  }
};

const searchGutenberg = async (query) => {
  const response = await withTimeout(`${GUTENDEX_HOST}/books/?search=${encodeURIComponent(query)}`, { timeoutMs: SEARCH_TIMEOUT_MS });
  if (!response.ok) throw new Error(`Gutenberg search failed with ${response.status}`);
  const payload = await safeJson(response);
  const list = Array.isArray(payload?.results) ? payload.results : [];
  return list.slice(0, 24).map((entry) => {
    const gutenbergId = Number(entry?.id);
    const title = normalizeTitle(entry?.title, `Project Gutenberg #${gutenbergId || 'Unknown'}`);
    const author = normalizeAuthor(entry?.authors?.[0]?.name);
    return toUnifiedBook({
      source: SOURCE_GUTENBERG,
      sourceId: String(gutenbergId),
      title,
      author,
      coverImage: entry?.formats?.['image/jpeg'] || `https://www.gutenberg.org/cache/epub/${gutenbergId}/pg${gutenbergId}.cover.medium.jpg`,
      extras: {
        gutenbergId,
        formats: entry?.formats || undefined,
      },
    });
  });
};

const searchOpenLibrary = async (query) => {
  const response = await withTimeout(`${OPEN_LIBRARY_HOST}/search.json?q=${encodeURIComponent(query)}&has_fulltext=true&limit=24`, { timeoutMs: SEARCH_TIMEOUT_MS });
  if (!response.ok) throw new Error(`OpenLibrary search failed with ${response.status}`);
  const payload = await safeJson(response);
  const list = Array.isArray(payload?.docs) ? payload.docs : [];

  return list.slice(0, 24).map((entry) => {
    const sourceId = String(entry?.key || entry?.cover_edition_key || entry?.edition_key?.[0] || '').trim();
    const cleanSourceId = sourceId.replace(/^\/works\//, '').replace(/^\/books\//, '');
    const author = Array.isArray(entry?.author_name) && entry.author_name.length ? entry.author_name[0] : 'Unknown author';
    const coverId = entry?.cover_i || null;
    const coverImage = coverId
      ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
      : (entry?.cover_edition_key ? `https://covers.openlibrary.org/b/olid/${entry.cover_edition_key}-L.jpg` : null);

    return toUnifiedBook({
      source: SOURCE_OPEN_LIBRARY,
      sourceId: cleanSourceId || String(entry?.edition_key?.[0] || entry?.title || 'unknown'),
      title: entry?.title,
      author,
      coverImage,
      extras: {
        openLibraryKey: entry?.key,
        ia: Array.isArray(entry?.ia) ? entry.ia : [],
      },
    });
  });
};

const searchInternetArchive = async (query) => {
  const normalized = await searchArchiveBooks(query, { maxResults: 24, timeoutMs: 1500 });
  return normalized.map((entry) => toUnifiedBook({
    source: SOURCE_ARCHIVE,
    sourceId: entry.id,
    title: entry.title,
    author: entry.author,
    coverImage: entry.cover,
    extras: {
      isPublicDomain: Boolean(entry.isPublicDomain),
      readable: false,
      formats: [],
      downloadUrl: null,
      sourceUrl: getArchiveDetailsUrl(entry.id),
      availability: 'preview',
      availabilityNote: 'Archive item metadata loaded. Open source link for lending/preview unless marked open access.',
    },
  }));
};

export const aggregateBookSearch = async (query) => {
  const term = String(query || '').trim();
  if (!term) return [];

  const [gutenberg, openlibrary, archive] = await Promise.all([
    runSourceSafely(SOURCE_GUTENBERG, () => searchGutenberg(term)),
    runSourceSafely(SOURCE_OPEN_LIBRARY, () => searchOpenLibrary(term)),
    runSourceSafely(SOURCE_ARCHIVE, () => searchInternetArchive(term)),
  ]);

  const merged = uniqueById([...gutenberg, ...openlibrary, ...archive]);
  log(
    `[BOOK][SEARCH] Aggregated ${merged.length} total results (gutenberg=${gutenberg.length}, openlibrary=${openlibrary.length}, archive=${archive.length})`,
  );
  return merged.slice(0, 48);
};

const readGutenberg = async ({ sourceId, readGutenbergBookStateless, buildReaderOptions }) => {
  const gutenbergId = Number(sourceId);
  const payload = await readGutenbergBookStateless(gutenbergId, buildReaderOptions());
  return {
    source: SOURCE_GUTENBERG,
    sourceId: String(gutenbergId),
    title: payload?.title,
    author: payload?.author,
    chapters: Array.isArray(payload?.chapters) ? payload.chapters : [],
    availability: 'full',
    availabilityNote: 'Full text from Project Gutenberg.',
    meta: payload,
  };
};

const getOpenLibraryEditions = async (workId) => {
  const url = `${OPEN_LIBRARY_HOST}/works/${encodeURIComponent(workId)}/editions.json?limit=15`;
  const response = await withTimeout(url, { timeoutMs: READ_TIMEOUT_MS });
  if (!response.ok) return [];
  const payload = await safeJson(response);
  return Array.isArray(payload?.entries) ? payload.entries : [];
};

const readOpenLibrary = async ({ sourceId }) => {
  const workId = String(sourceId || '').replace(/^OL/, 'OL').replace(/W$/, 'W');
  const workResponse = await withTimeout(`${OPEN_LIBRARY_HOST}/works/${encodeURIComponent(workId)}.json`, { timeoutMs: READ_TIMEOUT_MS });
  if (!workResponse.ok) throw new Error(`OpenLibrary read failed with ${workResponse.status}`);

  const work = await safeJson(workResponse);
  const title = normalizeTitle(work?.title, `OpenLibrary ${workId}`);

  let author = 'Unknown author';
  if (Array.isArray(work?.authors) && work.authors.length > 0) {
    const authorKey = work.authors[0]?.author?.key;
    if (authorKey) {
      const authorResponse = await withTimeout(`${OPEN_LIBRARY_HOST}${authorKey}.json`, { timeoutMs: READ_TIMEOUT_MS });
      if (authorResponse.ok) {
        const authorData = await safeJson(authorResponse);
        author = normalizeAuthor(authorData?.name);
      }
    }
  }

  const editions = await getOpenLibraryEditions(workId);
  const iaIdentifier = editions
    .flatMap((edition) => (Array.isArray(edition?.ia_box_id) ? edition.ia_box_id : []))
    .find(Boolean)
    || editions
      .flatMap((edition) => (Array.isArray(edition?.ocaid) ? edition.ocaid : [edition?.ocaid]))
      .find(Boolean)
    || null;

  const previewLines = [
    `OpenLibrary work: ${title}`,
    iaIdentifier ? `Internet Archive identifier: ${iaIdentifier}` : 'No full-text identifier was detected for this OpenLibrary work.',
    'Use the source link to view lending/preview options where available.',
  ];

  return {
    source: SOURCE_OPEN_LIBRARY,
    sourceId: workId,
    title,
    author,
    chapters: textToSingleChapter(previewLines.join('\n\n'), 'OpenLibrary Preview'),
    sourceUrl: `${OPEN_LIBRARY_HOST}/works/${workId}`,
    availability: 'preview',
    availabilityNote: 'OpenLibrary API does not expose full plaintext for this work in-app. Open source link for borrowing/preview.',
  };
};

const readInternetArchive = async ({ sourceId }) => {
  const identifier = String(sourceId || '').trim();
  if (!identifier) throw new Error('Internet Archive identifier is required.');

  const baseBook = {
    id: identifier,
    sourceId: identifier,
    source: SOURCE_ARCHIVE,
    title: identifier,
    author: 'Unknown author',
    isPublicDomain: false,
    readable: false,
    formats: [],
    downloadUrl: null,
  };

  const enriched = await enrichArchiveReadability(baseBook, { timeoutMs: READ_TIMEOUT_MS });
  const metadata = enriched?.metadata || {};
  const title = normalizeTitle(metadata?.metadata?.title, identifier);
  const author = normalizeAuthor(Array.isArray(metadata?.metadata?.creator) ? metadata.metadata.creator[0] : metadata?.metadata?.creator);

  if (!enriched?.isPublicDomain) {
    logArchiveMetric('archive_skipped_non_public_domain');
    return {
      source: SOURCE_ARCHIVE,
      sourceId: identifier,
      title,
      author,
      chapters: textToSingleChapter(
        'This Archive.org title is metadata-only in-app because rights are not open-access. Use the source link to view lending or preview options.',
        'Archive.org External Access',
      ),
      sourceUrl: getArchiveDetailsUrl(identifier),
      availability: 'preview',
      availabilityNote: 'Metadata only. Reader and live rooms are limited to open-access Archive.org books.',
      isPublicDomain: false,
      readable: false,
      formats: [],
    };
  }

  if (!enriched.readable || !enriched.downloadUrl) {
    logArchiveMetric('archive_failed_fetch');
    return {
      source: SOURCE_ARCHIVE,
      sourceId: identifier,
      title,
      author,
      chapters: textToSingleChapter(
        'This open-access Archive.org title does not expose txt/epub/pdf formats suitable for the in-app reader.',
        'Archive.org Format Unavailable',
      ),
      sourceUrl: getArchiveDetailsUrl(identifier),
      availability: 'preview',
      availabilityNote: 'Open-access detected, but no supported reader format is currently available.',
      isPublicDomain: true,
      readable: false,
      formats: Array.isArray(enriched.formats) ? enriched.formats : [],
    };
  }

  let chapters = [];
  if (enriched.formats.includes('txt')) {
    const textResponse = await withTimeout(enriched.downloadUrl, { timeoutMs: READ_TIMEOUT_MS });
    if (textResponse.ok) {
      const text = await safeText(textResponse);
      chapters = textToSingleChapter(String(text || '').slice(0, 140000), 'Archive.org Text Preview');
    }
  }

  if (!chapters.length) {
    chapters = textToSingleChapter(
      'Open-access title detected. Use the source link for the full files while this in-app preview is being prepared.',
      'Archive.org Open Access',
    );
  }

  logArchiveMetric('archive_ingested_count');
  return {
    source: SOURCE_ARCHIVE,
    sourceId: identifier,
    title,
    author,
    chapters,
    sourceUrl: getArchiveDetailsUrl(identifier),
    availability: 'full',
    availabilityNote: 'Open-access Archive.org text loaded for in-app reading.',
    isPublicDomain: true,
    readable: true,
    formats: Array.isArray(enriched.formats) ? enriched.formats : [],
  };
};

const readGoogleBooks = async ({ sourceId }) => {
  const volumeId = String(sourceId || '').trim();
  if (!volumeId) throw new Error('Google Books volume id is required.');

  const params = new URLSearchParams();
  const apiKey = String(process.env.GOOGLE_BOOKS_API_KEY || '').trim();
  if (apiKey) params.set('key', apiKey);

  const url = params.toString()
    ? `${GOOGLE_BOOKS_HOST}/${encodeURIComponent(volumeId)}?${params.toString()}`
    : `${GOOGLE_BOOKS_HOST}/${encodeURIComponent(volumeId)}`;

  const response = await withTimeout(url, { timeoutMs: READ_TIMEOUT_MS });
  if (!response.ok) throw new Error(`Google Books read failed with ${response.status}`);
  const payload = await safeJson(response);

  const info = payload?.volumeInfo || {};
  const title = normalizeTitle(info?.title, `Google Books ${volumeId}`);
  const author = normalizeAuthor(Array.isArray(info?.authors) ? info.authors[0] : info?.authors);

  const previewLines = [
    `Google Books title: ${title}`,
    author ? `Author: ${author}` : null,
    Array.isArray(info?.categories) && info.categories.length ? `Categories: ${info.categories.join(', ')}` : null,
    info?.previewLink ? `Preview: ${info.previewLink}` : null,
    info?.infoLink ? `Info: ${info.infoLink}` : null,
    'Google Books API does not provide full plaintext content. Use the preview link where available.',
  ].filter(Boolean);

  return {
    source: SOURCE_GOOGLE_BOOKS,
    sourceId: volumeId,
    title,
    author,
    chapters: textToSingleChapter(previewLines.join('\n\n'), 'Google Books Preview'),
    sourceUrl: String(info?.previewLink || info?.infoLink || '').trim() || null,
    availability: 'preview',
    availabilityNote: 'Google Books provides metadata/preview links only in-app.',
  };
};

export const readBookFromSource = async ({ source, sourceId, readGutenbergBookStateless, buildReaderOptions }) => {
  const normalizedSource = String(source || '').trim().toLowerCase();
  if (!normalizedSource) throw new Error('Source is required.');

  if (normalizedSource === SOURCE_GUTENBERG) {
    return readGutenberg({ sourceId, readGutenbergBookStateless, buildReaderOptions });
  }

  if (normalizedSource === SOURCE_OPEN_LIBRARY) {
    return readOpenLibrary({ sourceId });
  }

  if (normalizedSource === SOURCE_ARCHIVE || normalizedSource === SOURCE_INTERNET_ARCHIVE) {
    return readInternetArchive({ sourceId });
  }

  if (normalizedSource === SOURCE_GOOGLE_BOOKS) {
    return readGoogleBooks({ sourceId });
  }

  throw new Error(`Unsupported source: ${normalizedSource}`);
};

export const splitCompositeSourceId = (value) => {
  const raw = String(value || '').trim();
  if (!raw.includes(':')) return null;
  const [source, ...rest] = raw.split(':');
  const sourceId = rest.join(':').trim();
  if (!source || !sourceId) return null;
  return { source: source.trim().toLowerCase(), sourceId };
};


const archivePublicDomainCache = new Map();

const summarizeArchiveEligibility = ({ source, sourceId, enriched, cached = false, error = null }) => {
  const metadata = enriched?.metadata?.metadata || {};
  const summary = {
    source,
    sourceId,
    bookFound: Boolean(enriched?.metadata),
    metadataLoaded: Boolean(enriched?.metadata?.metadata),
    isPublicDomain: Boolean(enriched?.isPublicDomain),
    rights: metadata?.rights ?? null,
    licenseurl: metadata?.licenseurl ?? null,
    access: metadata?.access ?? metadata?.access_restricted ?? null,
    availability: metadata?.availability ?? null,
    sourceField: metadata?.source ?? null,
    readable: Boolean(enriched?.readable),
    formats: Array.isArray(enriched?.formats) ? enriched.formats : [],
    eligible: Boolean(enriched?.isPublicDomain),
    reason: error
      ? `metadata lookup failed: ${error?.name || 'Error'} ${error?.message || ''}`.trim()
      : (enriched?.isPublicDomain ? 'public-domain rights/license detected' : 'no public-domain rights/license detected'),
    cached,
  };
  log(`[ARCHIVE][ELIGIBILITY] ${JSON.stringify(summary)}`);
  return summary;
};

export const evaluateArchiveRoomEligibility = async ({ source, sourceId, timeoutMs = 5000 } = {}) => {
  const normalizedSource = String(source || '').trim().toLowerCase();
  if (normalizedSource !== SOURCE_ARCHIVE && normalizedSource !== SOURCE_INTERNET_ARCHIVE) {
    return { eligible: true, reason: 'non-archive source' };
  }

  const id = String(sourceId || '').trim();
  if (!id) {
    const summary = { source: normalizedSource, sourceId: id, eligible: false, reason: 'missing archive identifier' };
    log(`[ARCHIVE][ELIGIBILITY] ${JSON.stringify(summary)}`);
    return summary;
  }

  const cached = archivePublicDomainCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    summarizeArchiveEligibility({ source: normalizedSource, sourceId: id, enriched: cached.enriched, cached: true });
    return { ...cached.summary, cached: true };
  }

  try {
    const enriched = await enrichArchiveReadability({ id, sourceId: id, source: SOURCE_ARCHIVE }, { timeoutMs });
    const summary = summarizeArchiveEligibility({ source: normalizedSource, sourceId: id, enriched });
    archivePublicDomainCache.set(id, { summary, enriched, expiresAt: Date.now() + 5 * 60 * 1000 });
    if (!summary.eligible) logArchiveMetric('archive_skipped_non_public_domain');
    return summary;
  } catch (error) {
      logArchiveMetric('archive_failed_fetch');

      // Don't convert transient network failures into copyright failures.
      if (error?.name === 'AbortError') {
          return {
              eligible: true,
              reason: 'Archive eligibility service timed out; allowing temporarily.',
              temporary: true,
          };
      }

      const summary = summarizeArchiveEligibility({
          source: normalizedSource,
          sourceId: id,
          enriched: null,
          error,
      });

      return summary;
  }
};

export const canCreateArchiveRooms = async ({ source, sourceId }) => {
  const summary = await evaluateArchiveRoomEligibility({ source, sourceId });
  return Boolean(summary?.eligible);
};

export const SOURCE_NAMES = {
  SOURCE_GUTENBERG,
  SOURCE_OPEN_LIBRARY,
  SOURCE_ARCHIVE,
  SOURCE_INTERNET_ARCHIVE,
  SOURCE_GOOGLE_BOOKS,
};
