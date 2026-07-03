const OPEN_LIBRARY_BASE = 'https://covers.openlibrary.org';
const GUTENBERG_COVER_BASE = 'https://www.gutenberg.org/cache/epub';

const normalizeIsbn = (value) => {
  if (!value) return null;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = normalizeIsbn(entry);
      if (normalized) return normalized;
    }
    return null;
  }

  if (typeof value !== 'string') return null;

  const cleaned = value.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (cleaned.length === 10 || cleaned.length === 13) return cleaned;
  return null;
};

const getBookIsbn = (book) => {
  if (!book) return null;
  return (
    normalizeIsbn(book.isbn)
    || normalizeIsbn(book.isbn13)
    || normalizeIsbn(book.isbn10)
    || normalizeIsbn(book.identifiers?.isbn)
    || null
  );
};

const getCoverId = (book) => {
  const candidates = [book?.coverId, book?.cover_id, book?.cover?.id, book?.metadata?.coverId];
  const match = candidates.find((value) => value !== null && value !== undefined && String(value).trim() !== '');
  return match ? String(match).trim() : null;
};

export const getOpenLibraryCoverUrl = (book) => {
  if (!book) return null;

  if (book.coverImage) return book.coverImage;
  if (book.cover) return book.cover;

  const coverId = getCoverId(book);
  if (coverId) {
    return `${OPEN_LIBRARY_BASE}/b/id/${encodeURIComponent(coverId)}-L.jpg?default=false`;
  }

  const isbn = getBookIsbn(book);
  if (isbn) {
    return `${OPEN_LIBRARY_BASE}/b/isbn/${encodeURIComponent(isbn)}-L.jpg?default=false`;
  }

  return null;
};

export const getGutenbergCoverUrl = (book) => {
  const gutenbergId = String(book?.gutenbergId || '').trim();
  if (!/^\d+$/.test(gutenbergId)) return null;

  return `${GUTENBERG_COVER_BASE}/${encodeURIComponent(gutenbergId)}/pg${encodeURIComponent(gutenbergId)}.cover.medium.jpg`;
};

export const getBestCoverUrl = (book) => {
  if (!book) return null;

  return getOpenLibraryCoverUrl(book) || getGutenbergCoverUrl(book);
};
