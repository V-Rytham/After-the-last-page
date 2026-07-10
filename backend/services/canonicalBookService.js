import mongoose from 'mongoose';
import { CanonicalBook } from '../models/CanonicalBook.js';
import { BookSource } from '../models/BookSource.js';

const SOURCE_ALIASES = new Map([
  ['gutendex', 'gutendex'],
  ['gutenberg', 'gutendex'],
  ['openlibrary', 'openlibrary'],
  ['google', 'google'],
  ['googlebooks', 'google'],
  ['archive', 'archive'],
  ['internetarchive', 'archive'],
]);

const IDENTITY_CACHE_TTL_MS = 5 * 60 * 1000;
const identityCache = new Map();

const toNonEmptyString = (value) => String(value || '').trim();

export const normalizeText = (value) => toNonEmptyString(value)
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeIsbn = (value) => toNonEmptyString(value).replace(/[^0-9xX]/g, '').toLowerCase();

const normalizeSource = (value) => {
  const normalized = toNonEmptyString(value).toLowerCase();
  return SOURCE_ALIASES.get(normalized) || '';
};

const withTimeout = async (url, timeoutMs = 12_000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const fetchJson = async (url, timeoutMs = 12_000) => {
  const response = await withTimeout(url, timeoutMs);
  if (!response.ok) {
    const error = new Error(`Metadata fetch failed (${response.status})`);
    error.statusCode = response.status;
    throw error;
  }
  return response.json();
};

const extractMetadata = async ({ source, sourceBookId }) => {
  if (source === 'gutendex') {
    // Trailing slash is load-bearing: gutendex 301s `/books/{id}` to `/books/{id}/`.
    const payload = await fetchJson(`https://gutendex.com/books/${encodeURIComponent(sourceBookId)}/`);
    return {
      title: toNonEmptyString(payload?.title),
      author: toNonEmptyString(payload?.authors?.[0]?.name),
      isbn: '',
      raw_metadata: payload,
    };
  }

  if (source === 'openlibrary') {
    const candidate = sourceBookId.replace(/^\/(works|books)\//i, '');
    const preferWork = /W$/i.test(candidate);
    const firstUrl = preferWork
      ? `https://openlibrary.org/works/${encodeURIComponent(candidate)}.json`
      : `https://openlibrary.org/books/${encodeURIComponent(candidate)}.json`;

    let payload = null;
    try {
      payload = await fetchJson(firstUrl);
    } catch {
      const fallbackUrl = preferWork
        ? `https://openlibrary.org/books/${encodeURIComponent(candidate)}.json`
        : `https://openlibrary.org/works/${encodeURIComponent(candidate)}.json`;
      payload = await fetchJson(fallbackUrl);
    }

    let author = '';
    const authorKey = payload?.authors?.[0]?.author?.key || payload?.by_statement;
    if (typeof authorKey === 'string' && authorKey.startsWith('/authors/')) {
      try {
        const authorPayload = await fetchJson(`https://openlibrary.org${authorKey}.json`, 8_000);
        author = toNonEmptyString(authorPayload?.name);
      } catch {
        author = '';
      }
    } else {
      author = toNonEmptyString(authorKey);
    }

    const isbn = Array.isArray(payload?.isbn_13) ? payload.isbn_13[0] : (Array.isArray(payload?.isbn_10) ? payload.isbn_10[0] : '');
    return {
      title: toNonEmptyString(payload?.title),
      author,
      isbn: toNonEmptyString(isbn),
      raw_metadata: payload,
    };
  }

  if (source === 'google') {
    const payload = await fetchJson(`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(sourceBookId)}`);
    const volumeInfo = payload?.volumeInfo || {};
    const industryIdentifiers = Array.isArray(volumeInfo?.industryIdentifiers) ? volumeInfo.industryIdentifiers : [];
    const isbn = industryIdentifiers.find((item) => /isbn/i.test(String(item?.type || '')))?.identifier || '';
    return {
      title: toNonEmptyString(volumeInfo?.title),
      author: toNonEmptyString(Array.isArray(volumeInfo?.authors) ? volumeInfo.authors[0] : ''),
      isbn: toNonEmptyString(isbn),
      raw_metadata: payload,
    };
  }

  if (source === 'archive') {
    const payload = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(sourceBookId)}`);
    const metadata = payload?.metadata || {};
    const author = Array.isArray(metadata?.creator) ? metadata.creator[0] : metadata?.creator;
    const isbn = Array.isArray(metadata?.isbn) ? metadata.isbn[0] : metadata?.isbn;
    return {
      title: toNonEmptyString(metadata?.title || sourceBookId),
      author: toNonEmptyString(author),
      isbn: toNonEmptyString(isbn),
      raw_metadata: payload,
    };
  }

  const error = new Error('Unsupported source.');
  error.statusCode = 400;
  throw error;
};

const buildNormalizedIdentityKey = ({ title, author, isbn }) => {
  const normalizedIsbn = normalizeIsbn(isbn);
  if (normalizedIsbn) return normalizedIsbn;

  const normalizedTitle = normalizeText(title);
  const normalizedAuthor = normalizeText(author);
  if (!normalizedTitle) {
    const error = new Error('Book metadata is incomplete.');
    error.statusCode = 422;
    throw error;
  }

  return normalizedAuthor ? `${normalizedTitle}::${normalizedAuthor}` : normalizedTitle;
};

const fromCache = (cacheKey) => {
  const cached = identityCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    identityCache.delete(cacheKey);
    return null;
  }
  return cached.value;
};

const writeCache = (cacheKey, value) => {
  identityCache.set(cacheKey, { value, expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS });
};

export const getCanonicalBook = async ({ source, source_book_id: sourceBookId }) => {
  const normalizedSource = normalizeSource(source);
  const normalizedSourceBookId = toNonEmptyString(sourceBookId);

  if (!normalizedSource || !normalizedSourceBookId) {
    const error = new Error('source and source_book_id are required.');
    error.statusCode = 400;
    throw error;
  }

  const sourceCacheKey = `${normalizedSource}:${normalizedSourceBookId}`;
  const cached = fromCache(sourceCacheKey);
  if (cached) return cached;

  const existingSource = await BookSource.findOne({ source: normalizedSource, source_book_id: normalizedSourceBookId })
    .select('canonical_book_id source source_book_id')
    .lean();

  if (existingSource?.canonical_book_id) {
    const canonical = await CanonicalBook.findOne({ canonical_book_id: existingSource.canonical_book_id }).lean();
    if (canonical) {
      const resolved = { ...canonical, source: normalizedSource, source_book_id: normalizedSourceBookId };
      writeCache(sourceCacheKey, resolved);
      return resolved;
    }
  }

  const metadata = await extractMetadata({ source: normalizedSource, sourceBookId: normalizedSourceBookId });
  const normalizedKey = buildNormalizedIdentityKey(metadata);

  let canonical = null;
  try {
    canonical = await CanonicalBook.findOneAndUpdate(
      { normalized_key: normalizedKey },
      {
        $setOnInsert: {
          canonical_book_id: new mongoose.Types.ObjectId().toString(),
          title: metadata.title || 'Untitled',
          author: metadata.author || '',
          normalized_key: normalizedKey,
        },
        $set: {
          updatedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    ).lean();
  } catch (error) {
    if (error?.code === 11000) {
      canonical = await CanonicalBook.findOne({ normalized_key: normalizedKey }).lean();
    } else {
      throw error;
    }
  }

  if (!canonical?.canonical_book_id) {
    const error = new Error('Unable to resolve canonical book identity.');
    error.statusCode = 500;
    throw error;
  }

  await BookSource.findOneAndUpdate(
    { source: normalizedSource, source_book_id: normalizedSourceBookId },
    {
      $set: {
        canonical_book_id: canonical.canonical_book_id,
        source: normalizedSource,
        source_book_id: normalizedSourceBookId,
        raw_metadata: metadata.raw_metadata || {},
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );

  const resolved = { ...canonical, source: normalizedSource, source_book_id: normalizedSourceBookId };
  writeCache(sourceCacheKey, resolved);
  return resolved;
};
