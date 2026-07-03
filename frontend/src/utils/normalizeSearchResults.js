const toList = (value) => (Array.isArray(value) ? value : []);

const firstString = (...values) => {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstString(...value);
      if (nested) return nested;
      continue;
    }

    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }

  return '';
};

const normalizeBook = (book) => {
  const source = String(book?.source || '').trim().toLowerCase();
  const sourceBookId = String(book?.sourceId || book?.source_book_id || '').trim();
  if (!source || !sourceBookId) return null;

  const title = String(book?.title || 'Untitled').trim() || 'Untitled';
  const author = String(book?.author || 'Unknown author').trim() || 'Unknown author';
  const coverImage = firstString(
    book?.coverImage,
    book?.cover,
    book?.coverUrl,
    book?.cover_url,
    book?.image,
    book?.thumbnail,
    book?.imageLinks?.thumbnail,
    book?.imageLinks?.smallThumbnail,
    book?.volumeInfo?.imageLinks?.thumbnail,
    book?.volumeInfo?.imageLinks?.smallThumbnail,
    book?.formats?.['image/jpeg'],
    book?.formats?.['image/png'],
  ).replace('http://', 'https://');
  const gutenbergId = firstString(book?.gutenbergId, source === 'gutenberg' ? sourceBookId : '');

  return {
    ...book,
    id: sourceBookId,
    title,
    author,
    cover: coverImage,
    coverImage,
    source,
    sourceId: sourceBookId,
    source_book_id: sourceBookId,
    gutenbergId,
  };
};

export default function normalizeSearchResults(results) {
  return toList(results).map(normalizeBook).filter(Boolean);
}

export { normalizeBook, toList };
