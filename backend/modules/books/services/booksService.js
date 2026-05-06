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
  envEnabledKey: 'SEARCH_SERVICE_ENABLED',
  fallbackEnabled: true,
});

const toStableBookShape = (book) => {
  const gutenbergId = Number(book?.gutenbergId);
  if (!Number.isFinite(gutenbergId) || gutenbergId <= 0) return null;

  const objectId = book?._id ? String(book._id) : null;
  return {
    ...book,
    id: objectId || `gutenberg:${gutenbergId}`,
    _id: objectId || null,
    gutenbergId,
    title: String(book?.title || 'Untitled'),
    author: String(book?.author || 'Unknown author'),
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
    if (!q) return { results: [] };

    const cached = this.searchCache.get(q);
    if (cached) return { results: cached };

    const localResults = this.repository.getCatalogEntries()
      .filter((book) => {
        const idString = String(book?.gutenbergId || '');
        const title = String(book?.title || '').toLowerCase();
        const author = String(book?.author || '').toLowerCase();
        return title.includes(q) || author.includes(q) || idString === q;
      })
      .slice(0, 30)
      .map((book) => toStableBookShape(book))
      .filter(Boolean)
      .map((book) => ({
        ...book,
        source: this.repository.getSourceNames().SOURCE_GUTENBERG,
        sourceId: String(book.gutenbergId),
        coverImage: `https://www.gutenberg.org/cache/epub/${book.gutenbergId}/pg${book.gutenbergId}.cover.medium.jpg`,
      }));

    let aggregated = [];
    let remoteSearchFailed = false;
    if (searchClient.isEnabled()) {
      try {
        log('[BOOKS_SEARCH] Delegating query to search microservice', { q });
        const payload = await searchClient.get(`/api/books/search?q=${encodeURIComponent(q)}`);
        aggregated = Array.isArray(payload?.results) ? payload.results : [];
        log('[BOOKS_SEARCH] Search microservice response received', { q, results: aggregated.length });
      } catch (error) {
        if (!error?.allowLocalFallback) throw error;
        remoteSearchFailed = true;
        log('[BOOKS_SEARCH] Search microservice failed; using local fallback', { q, reason: error?.message || 'unknown' });
      }
    }

    if (!searchClient.isEnabled() || remoteSearchFailed) {
      aggregated = await this.repository.runAggregatedSearch(q);
      log('[BOOKS_SEARCH] Local aggregated search completed', { q, results: aggregated.length });
    }
    if (aggregated.length === 0 && /^\d+$/.test(q)) {
      try {
        const remoteBook = await this.fetchMetadataSingleFlight(Number(q));
        if (remoteBook) {
          aggregated = [{
            ...remoteBook,
            source: this.repository.getSourceNames().SOURCE_GUTENBERG,
            sourceId: String(remoteBook.gutenbergId),
            coverImage: `https://www.gutenberg.org/cache/epub/${remoteBook.gutenbergId}/pg${remoteBook.gutenbergId}.cover.medium.jpg`,
          }];
        }
      } catch (error) {
        if (![400, 404].includes(Number(error?.statusCode))) throw error;
      }
    }

    const results = Array.from(
      new Map([...localResults, ...aggregated].map((book) => [String(book?.id || `${book?.source}:${book?.sourceId}`), book])).values(),
    );

    this.searchCache.set(q, results);
    return { results };
  }

  async getBookById({ id }) {
    if (isDegradedMode()) {
      const error = new Error('Book metadata lookup unavailable in degraded mode.');
      error.statusCode = 503;
      error.payload = { fallback: true };
      throw error;
    }

    const book = await this.repository.findBookByObjectId(id, 'title author gutenbergId');
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

    const book = await this.repository.findBookByObjectId(id, 'title author gutenbergId');
    if (!book) {
      const error = new Error('Book not found.');
      error.statusCode = 404;
      throw error;
    }

    const payload = await readGutenbergBookStateless(book.gutenbergId, this.buildReaderOptions(query));
    const persisted = await this.repository.upsertMetadata({
      gutenbergId: payload.gutenbergId,
      title: payload.title,
      author: payload.author,
    });

    return this.buildReadResponse({
      payload,
      bookId: persisted?._id ? String(persisted._id) : String(book._id),
      source: this.repository.getSourceNames().SOURCE_GUTENBERG,
      sourceId: String(payload.gutenbergId),
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
      : await this.repository.upsertMetadata({
          gutenbergId: payload.gutenbergId,
          title: payload.title,
          author: payload.author,
        });

    return this.buildReadResponse({
      payload,
      bookId: persisted?._id ? String(persisted._id) : `gutenberg:${payload.gutenbergId}`,
      fallback: isDegradedMode(),
      source: this.repository.getSourceNames().SOURCE_GUTENBERG,
      sourceId: String(payload.gutenbergId),
    });
  }

  async readBookBySource({ query }) {
    const { source, id } = buildReadBookBySourceDto({ query });
    const composite = this.repository.parseCompositeSourceId(id);
    const normalizedSource = source || composite?.source || '';
    const sourceId = composite?.sourceId || id;

    validateRequired(normalizedSource, 'Both source and id are required.');
    validateRequired(sourceId, 'Both source and id are required.');

    try {
      const payload = await this.repository.readBySource({
        source: normalizedSource,
        sourceId,
        readGutenbergBookStateless,
        buildReaderOptions: () => this.buildReaderOptions(query),
      });

      const chapters = Array.isArray(payload?.chapters) && payload.chapters.length > 0
        ? payload.chapters
        : [{ index: 1, title: 'Unavailable', html: '<p>No chapter content is available for this source.</p>' }];

      return {
        success: true,
        source: normalizedSource,
        sourceId,
        availability: payload?.availability || 'unknown',
        availabilityNote: payload?.availabilityNote || null,
        data: {
          title: String(payload?.title || 'Untitled'),
          author: String(payload?.author || 'Unknown author'),
          chapters,
          availability: payload?.availability || 'unknown',
          availabilityNote: payload?.availabilityNote || null,
        },
        title: String(payload?.title || 'Untitled'),
        author: String(payload?.author || 'Unknown author'),
        chapters,
        sourceUrl: payload?.sourceUrl || null,
      };
    } catch {
      return {
        success: true,
        source: normalizedSource,
        sourceId,
        data: {
          title: 'Preview unavailable',
          author: 'Unknown author',
          chapters: [{ index: 1, title: 'Fallback Preview', html: '<p>This source is temporarily unavailable. Please retry shortly.</p>' }],
        },
        title: 'Preview unavailable',
        author: 'Unknown author',
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

  buildReadResponse({ payload, bookId, fallback = false, source, sourceId }) {
    const responseData = {
      ...payload,
      bookId,
      fallback,
      source,
      sourceId,
    };

    return {
      ...responseData,
      success: true,
      data: {
        title: responseData.title,
        author: responseData.author,
        chapters: Array.isArray(responseData.chapters) ? responseData.chapters : [],
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
