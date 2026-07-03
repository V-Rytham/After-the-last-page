const toList = (value) => (Array.isArray(value) ? value : []);

const normalizeBook = (book) => {
  const source = String(book?.source || '').trim().toLowerCase();
  const sourceBookId = String(book?.sourceId || book?.source_book_id || '').trim();
  if (!source || !sourceBookId) return null;

  const title = String(book?.title || 'Untitled').trim() || 'Untitled';
  const author = String(book?.author || 'Unknown author').trim() || 'Unknown author';
  const coverImage = String(book?.coverImage || book?.cover || '').trim();

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
  };
};

export default function normalizeSearchResults(results) {
  return toList(results).map(normalizeBook).filter(Boolean);
}

export { normalizeBook, toList };
