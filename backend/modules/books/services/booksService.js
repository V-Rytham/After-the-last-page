import { parseStrictGutenbergId, readGutenbergBookStateless } from '../../../utils/gutenbergReader.js';
import { isDegradedMode } from '../../../utils/degradedMode.js';
import { appConfig } from '../../../shared/config/appConfig.js';
import { MemoryCache } from '../../../shared/cache/memoryCache.js';
import { createMicroserviceClient } from '../../../services/microserviceProxy.js';
import { log } from '../../../utils/logger.js';
import {
  buildReadBookBySourceDto,
  buildReaderOptionsDto,
  buildSearchBooksDto,
  validateRequired,
} from '../dto/booksDto.js';

const fallbackBooks = [
  { gutenbergId: 1342, title: 'Pride and Prejudice', author: 'Jane Austen' },
  { gutenbergId: 11, title: 'Alice in Wonderland', author: 'Lewis Carroll' },
  { gutenbergId: 84, title: 'Frankenstein', author: 'Mary Shelley' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const searchClient = createMicroserviceClient({
  envBaseUrlKey: 'SEARCH_SERVICE_URL',
  envTimeoutMsKey: 'SEARCH_SERVICE_TIMEOUT_MS',
  envEnabledKey: 'SEARCH_SERVICE_ENABLED'
});

const toStableBookShape = (book) => {
  const gutenbergId = Number(book?.gutenbergId);
  if (!Number.isFinite(gutenbergId) || gutenbergId <= 0) return null;

  const objectId = book?._id ? String(book._id) : null;
  const source = String(book?.source || (gutenbergId ? 'gutenberg' : '')).trim().toLowerCase();
  const sourceId = String(book?.sourceId || (gutenbergId ? gutenbergId : '')).trim();
  const coverImage = String(book?.coverImage || '').trim();
  return {
    ...book,
    id: objectId || `gutenberg:${gutenbergId}`,
    _id: objectId || null,
    gutenbergId,
    title: String(book?.title || 'Untitled'),
    author: String(book?.author || 'Unknown author'),
    source,
    sourceId,
    coverImage,
    cover: coverImage,
  };
};

const normalizeSearchResult = (book) => toStableBookShape({
  ...book,
  gutenbergId: Number(book?.gutenbergId || book?.id),
});

const mapReadErrorMessage = (statusCode) => {
  if (statusCode === 404) return 'Unable to fetch this book. Check the ID.';
  if (statusCode === 504) return 'This book is large and taking longer than expected.';
  return 'Unable to fetch this book right now. Please retry.';
};

const normalizeText = (value, fallback = '') => {
  const normalized = String(value || '').trim();
  return normalized || fallback;
};

const normalizeCoverImage = (value) => String(value || '').trim();

const isTruthyFlag = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

const buildGutenbergCover = (gutenbergId) => {
  const normalized = String(gutenbergId || '').trim();
  if (!/^\d+$/.test(normalized)) return '';
  return `https://www.gutenberg.org/cache/epub/${normalized}/pg${normalized}.cover.medium.jpg`;
};

const extractCoverImage = ({ payload, source, sourceId, storedCoverImage = '', hintedCoverImage = '' }) => {
  const payloadCover = normalizeCoverImage(
    payload?.coverImage
    || payload?.meta?.formats?.['image/jpeg']
    || payload?.meta?.formats?.['image/png'],
  );
  if (payloadCover) return payloadCover;

  if (normalizeCoverImage(storedCoverImage)) return normalizeCoverImage(storedCoverImage);
  if (normalizeCoverImage(hintedCoverImage)) return normalizeCoverImage(hintedCoverImage);
  if (String(source || '').trim().toLowerCase() === 'gutenberg') return buildGutenbergCover(sourceId);
  return '';
};

const buildMetadataOnlyResponse = ({ source, sourceId, book, availability = 'unknown', availabilityNote = null }) => ({
  success: true,
  source,
  sourceId,
  availability,
  availabilityNote,
  coverImage: normalizeCoverImage(book?.coverImage),
  title: normalizeText(book?.title, 'Untitled'),
  author: normalizeText(book?.author, 'Unknown author'),
  data: {
    title: normalizeText(book?.title, 'Untitled'),
    author: normalizeText(book?.author, 'Unknown author'),
    chapters: [],
    coverImage: normalizeCoverImage(book?.coverImage),
    availability,
    availabilityNote,
  },
});

export class BooksService {
  constructor({ repository }) {
    this.repository = repository;
    this.searchCache = new MemoryCache({ ttlMs: appConfig.books.searchCacheTtlMs });
    this.metadataCache = new MemoryCache({ ttlMs: appConfig.books.metadataCacheTtlMs });
    this.inflightMetadata = new Map();
    this.lastRemoteSearchAt = 0;
  }

  async getBooks() {
    if (isDegradedMode()) {
      return fallbackBooks.map((book) => toStableBookShape(book)).filter(Boolean);
    }

    const books = await this.repository.listRecentBooks();
    return books.map((book) => toStableBookShape(book)).filter(Boolean);
  }

  async getLibraryFeed({ userId }) {
    const preferredGenres = userId ? await this.repository.getUserPreferredGenres(userId) : [];
    return {
      books: [],
      preferredGenres,
      personalized: false,
      deprecated: true,
    };
  }

  async searchBooks({ query }) {
    const { q } = buildSearchBooksDto({ query });
    if (!q) return { success: true, books: [], results: [] };

    const cached = this.searchCache.get(q);
    if (cached) return { success: true, books: cached, results: cached };

    const localFallbackSearch = () => {
      const haystack = this.repository.getCatalogEntries();
      const normalizedQuery = q.toLowerCase();
      return haystack
        .filter((book) => (
          String(book?.title || '').toLowerCase().includes(normalizedQuery)
          || String(book?.author || '').toLowerCase().includes(normalizedQuery)
        ))
        .slice(0, 60)
        .map(normalizeSearchResult)
        .filter(Boolean);
    };

    if (!searchClient.isEnabled()) {
      const fallback = localFallbackSearch();
      this.searchCache.set(q, fallback);
      return { success: true, books: fallback, results: fallback, fallback: true };
    }

    try {
      log('[BOOKS_SEARCH] Delegating query to search microservice', { q });
      const payload = await searchClient.get(`/api/books/search?q=${encodeURIComponent(q)}`);
      const aggregated = Array.isArray(payload?.results)
        ? payload.results
        : (Array.isArray(payload?.books) ? payload.books : []);
      log('[BOOKS_SEARCH] Search microservice response received', { q, results: aggregated.length });

      this.searchCache.set(q, aggregated);
      return { success: true, books: aggregated, results: aggregated };
    } catch (error) {
      const fallback = localFallbackSearch();
      log('[BOOKS_SEARCH] Search microservice failed; serving local fallback', { q, error: String(error?.message || error), fallbackCount: fallback.length });
      this.searchCache.set(q, fallback);
      return { success: true, books: fallback, results: fallback, fallback: true };
    }
  }


  async getBookById({ id }) {
    if (isDegradedMode()) {
      const error = new Error('Book metadata lookup unavailable in degraded mode.');
      error.statusCode = 503;
      error.payload = { fallback: true };
      throw error;
    }

    const book = await this.repository.findBookByObjectId(id, 'title author gutenbergId source sourceId coverImage');
    if (!book) {
      const error = new Error('Book not found');
      error.statusCode = 404;
      throw error;
    }
    return book;
  }

  async readBookById({ id, query }) {
    if (isDegradedMode()) {
      const error = new Error('Book reading by database id is unavailable in degraded mode.');
      error.statusCode = 503;
      error.payload = { fallback: true };
      throw error;
    }

    const book = await this.repository.findBookByObjectId(id, 'title author gutenbergId source sourceId coverImage');
    if (!book) {
      const error = new Error('Book not found.');
      error.statusCode = 404;
      throw error;
    }

    const payload = await readGutenbergBookStateless(book.gutenbergId, this.buildReaderOptions(query));
    const persisted = await this.repository.upsertSourceBook({
      source: this.repository.getSourceNames().SOURCE_GUTENBERG,
      sourceId: String(payload.gutenbergId),
      title: payload.title,
      author: payload.author,
      coverImage: buildGutenbergCover(payload.gutenbergId),
      gutenbergId: payload.gutenbergId,
    });

    return this.buildReadResponse({
      payload,
      bookId: persisted?._id ? String(persisted._id) : String(book._id),
      source: this.repository.getSourceNames().SOURCE_GUTENBERG,
      sourceId: String(payload.gutenbergId),
      coverImage: buildGutenbergCover(payload.gutenbergId),
    });
  }

  async getGutenbergPreview({ gutenbergIdParam }) {
    const gutenbergId = parseStrictGutenbergId(gutenbergIdParam);
    if (!gutenbergId) {
      const error = new Error('Invalid Gutenberg ID.');
      error.statusCode = 400;
      throw error;
    }

    if (!isDegradedMode()) {
      const existing = await this.repository.findBookByGutenbergId(gutenbergId);
      if (existing) return existing;
    }

    const catalogEntry = this.repository.getCatalogEntries().find((book) => Number(book?.gutenbergId) === gutenbergId);
    if (catalogEntry) {
      return {
        gutenbergId,
        title: catalogEntry.title || 'Untitled',
        author: catalogEntry.author || 'Unknown author',
      };
    }

    return this.fetchMetadataSingleFlight(gutenbergId);
  }

  async readGutenbergBook({ gutenbergIdParam, query }) {
    const gutenbergId = parseStrictGutenbergId(gutenbergIdParam);
    if (!gutenbergId) {
      const error = new Error('Invalid Gutenberg ID.');
      error.statusCode = 400;
      throw error;
    }

    const payload = await readGutenbergBookStateless(gutenbergId, this.buildReaderOptions(query));
    const persisted = isDegradedMode()
      ? null
      : await this.repository.upsertSourceBook({
          source: this.repository.getSourceNames().SOURCE_GUTENBERG,
          sourceId: String(payload.gutenbergId),
          title: payload.title,
          author: payload.author,
          coverImage: buildGutenbergCover(payload.gutenbergId),
          gutenbergId: payload.gutenbergId,
        });

    return this.buildReadResponse({
      payload,
      bookId: persisted?._id ? String(persisted._id) : `gutenberg:${payload.gutenbergId}`,
      fallback: isDegradedMode(),
      source: this.repository.getSourceNames().SOURCE_GUTENBERG,
      sourceId: String(payload.gutenbergId),
      coverImage: buildGutenbergCover(payload.gutenbergId),
    });
  }

  async readBookBySource({ query }) {
    const { source, id } = buildReadBookBySourceDto({ query });
    const composite = this.repository.parseCompositeSourceId(id);
    const normalizedSource = source || composite?.source || '';
    const sourceId = composite?.sourceId || id;
    const metadataOnly = isTruthyFlag(query?.metadataOnly);
    const hintedBook = {
      title: normalizeText(query?.title),
      author: normalizeText(query?.author),
      coverImage: normalizeCoverImage(query?.coverImage),
    };

    validateRequired(normalizedSource, 'Both source and id are required.');
    validateRequired(sourceId, 'Both source and id are required.');

    const stored = await this.repository.findBookBySourceRef(normalizedSource, sourceId);
    if (metadataOnly && (stored || hintedBook.title || hintedBook.author || hintedBook.coverImage)) {
      const persisted = hintedBook.title || hintedBook.author || hintedBook.coverImage
        ? await this.repository.upsertSourceBook({
            source: normalizedSource,
            sourceId,
            title: hintedBook.title || stored?.title,
            author: hintedBook.author || stored?.author,
            coverImage: hintedBook.coverImage || stored?.coverImage,
            gutenbergId: stored?.gutenbergId || (/^\d+$/.test(String(sourceId)) && normalizedSource === this.repository.getSourceNames().SOURCE_GUTENBERG ? Number(sourceId) : null),
          })
        : stored;

      return buildMetadataOnlyResponse({
        source: normalizedSource,
        sourceId,
        book: persisted || hintedBook,
      });
    }

    try {
      const payload = await this.repository.readBySource({
        source: normalizedSource,
        sourceId,
        readGutenbergBookStateless,
        buildReaderOptions: () => this.buildReaderOptions(query),
      });

      const coverImage = extractCoverImage({
        payload,
        source: normalizedSource,
        sourceId,
        storedCoverImage: stored?.coverImage,
        hintedCoverImage: hintedBook.coverImage,
      });

      const persisted = await this.repository.upsertSourceBook({
        source: normalizedSource,
        sourceId,
        title: payload?.title,
        author: payload?.author,
        coverImage,
        gutenbergId: normalizedSource === this.repository.getSourceNames().SOURCE_GUTENBERG && /^\d+$/.test(String(sourceId))
          ? Number(sourceId)
          : stored?.gutenbergId,
      });

      if (metadataOnly) {
        return buildMetadataOnlyResponse({
          source: normalizedSource,
          sourceId,
          book: persisted || { ...payload, coverImage },
          availability: payload?.availability || 'unknown',
          availabilityNote: payload?.availabilityNote || null,
        });
      }

      const chapters = Array.isArray(payload?.chapters) && payload.chapters.length > 0
        ? payload.chapters
        : [{ index: 1, title: 'Unavailable', html: '<p>No chapter content is available for this source.</p>' }];

      return {
        success: true,
        source: normalizedSource,
        sourceId,
        availability: payload?.availability || 'unknown',
        availabilityNote: payload?.availabilityNote || null,
        coverImage,
        data: {
          title: String(payload?.title || 'Untitled'),
          author: String(payload?.author || 'Unknown author'),
          chapters,
          coverImage,
          availability: payload?.availability || 'unknown',
          availabilityNote: payload?.availabilityNote || null,
        },
        title: String(payload?.title || 'Untitled'),
        author: String(payload?.author || 'Unknown author'),
        chapters,
        sourceUrl: payload?.sourceUrl || null,
      };
    } catch {
      if (metadataOnly && stored) {
        return buildMetadataOnlyResponse({
          source: normalizedSource,
          sourceId,
          book: stored,
        });
      }

      return {
        success: true,
        source: normalizedSource,
        sourceId,
        coverImage: normalizeCoverImage(stored?.coverImage || hintedBook.coverImage),
        data: {
          title: normalizeText(stored?.title || hintedBook.title, 'Preview unavailable'),
          author: normalizeText(stored?.author || hintedBook.author, 'Unknown author'),
          chapters: [{ index: 1, title: 'Fallback Preview', html: '<p>This source is temporarily unavailable. Please retry shortly.</p>' }],
          coverImage: normalizeCoverImage(stored?.coverImage || hintedBook.coverImage),
        },
        title: normalizeText(stored?.title || hintedBook.title, 'Preview unavailable'),
        author: normalizeText(stored?.author || hintedBook.author, 'Unknown author'),
        chapters: [{ index: 1, title: 'Fallback Preview', html: '<p>This source is temporarily unavailable. Please retry shortly.</p>' }],
      };
    }
  }

  buildReaderOptions(query) {
    return buildReaderOptionsDto({
      query,
      backendTimeoutMs: appConfig.books.backendTimeoutMs,
      defaultProcessingBudgetMs: appConfig.books.reader.defaultProcessingBudgetMs,
    });
  }

  buildReadResponse({ payload, bookId, fallback = false, source, sourceId, coverImage = '' }) {
    const responseData = {
      ...payload,
      bookId,
      fallback,
      source,
      sourceId,
      coverImage: normalizeCoverImage(coverImage || payload?.coverImage),
    };

    return {
      ...responseData,
      success: true,
      data: {
        title: responseData.title,
        author: responseData.author,
        chapters: Array.isArray(responseData.chapters) ? responseData.chapters : [],
        coverImage: responseData.coverImage,
      },
    };
  }

  async fetchMetadataSingleFlight(gutenbergId) {
    const id = Number(gutenbergId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      const error = new Error('Invalid Gutenberg ID.');
      error.statusCode = 400;
      throw error;
    }

    const cached = this.metadataCache.get(id);
    if (cached) return cached;

    const existing = this.inflightMetadata.get(id);
    if (existing) return existing;

    const request = (async () => {
      const waitMs = Math.max(0, appConfig.books.searchThrottleMs - (Date.now() - this.lastRemoteSearchAt));
      if (waitMs > 0) await sleep(waitMs);
      this.lastRemoteSearchAt = Date.now();

      const payload = await this.repository.fetchRemoteMetadata(id, { timeoutMs: 15_000 });
      const normalized = normalizeSearchResult(payload);
      if (!normalized) {
        const error = new Error('Unable to fetch this Gutenberg book.');
        error.statusCode = 404;
        throw error;
      }

      this.metadataCache.set(id, normalized);
      return normalized;
    })().finally(() => {
      this.inflightMetadata.delete(id);
    });

    this.inflightMetadata.set(id, request);
    return request;
  }

  mapReadErrorMessage(statusCode) {
    return mapReadErrorMessage(statusCode);
  }
}
