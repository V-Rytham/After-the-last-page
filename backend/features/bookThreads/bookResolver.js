import crypto from 'node:crypto';
import { Book } from '../../models/Book.js';
import { BookSource } from '../../models/BookSource.js';
import { CanonicalBook } from '../../models/CanonicalBook.js';
import { badRequest, notFound } from './httpErrors.js';

const SOURCE_SYNTHETIC_BASE = 2_000_000_000;

const normalizeText = (value, fallback = '') => {
  const normalized = String(value || '').trim();
  return normalized || fallback;
};

const normalizeCoverImage = (value) => String(value || '').trim();

const parseGutenbergParam = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const match = raw.match(/^gutenberg:(\d+)$/i);
  const numeric = match ? match[1] : (/^\d+$/.test(raw) ? raw : null);
  if (!numeric) return null;

  const gutenbergId = Number(numeric);
  if (!Number.isSafeInteger(gutenbergId) || gutenbergId <= 0) return null;
  return gutenbergId;
};

const buildCanonicalSyntheticGutenbergId = (canonicalId) => {
  const syntheticBase = Number.parseInt(String(canonicalId || '').slice(-8), 16);
  return Number.isFinite(syntheticBase)
    ? 1_500_000_000 + syntheticBase
    : 1_900_000_000;
};

const buildSourceSyntheticGutenbergId = (source, sourceBookId) => {
  const hash = crypto.createHash('sha1').update(`${source}:${sourceBookId}`).digest('hex');
  return SOURCE_SYNTHETIC_BASE + Number.parseInt(hash.slice(0, 8), 16);
};

const extractSourceMetadata = ({ source, sourceBookId, rawMetadata, hints }) => {
  const normalizedSource = String(source || '').trim().toLowerCase();
  const metadata = rawMetadata && typeof rawMetadata === 'object' ? rawMetadata : {};
  const safeHints = hints && typeof hints === 'object' ? hints : {};

  if (normalizedSource === 'archive' || normalizedSource === 'internetarchive') {
    return {
      title: normalizeText(safeHints.title || metadata?.metadata?.title, sourceBookId),
      author: normalizeText(
        safeHints.author
        || (Array.isArray(metadata?.metadata?.creator) ? metadata.metadata.creator[0] : metadata?.metadata?.creator),
        'Unknown author',
      ),
      coverImage: normalizeCoverImage(safeHints.coverImage || `https://archive.org/services/img/${encodeURIComponent(sourceBookId)}`),
    };
  }

  if (normalizedSource === 'openlibrary') {
    const coverId = metadata?.covers?.[0] || metadata?.cover_id || metadata?.cover?.id;
    const fallbackCover = coverId ? `https://covers.openlibrary.org/b/id/${encodeURIComponent(String(coverId))}-L.jpg?default=false` : '';
    return {
      title: normalizeText(safeHints.title || metadata?.title, sourceBookId),
      author: normalizeText(safeHints.author || metadata?.by_statement, 'Unknown author'),
      coverImage: normalizeCoverImage(safeHints.coverImage || fallbackCover),
    };
  }

  if (normalizedSource === 'google' || normalizedSource === 'googlebooks') {
    const volumeInfo = metadata?.volumeInfo || {};
    return {
      title: normalizeText(safeHints.title || volumeInfo?.title, sourceBookId),
      author: normalizeText(safeHints.author || (Array.isArray(volumeInfo?.authors) ? volumeInfo.authors[0] : volumeInfo?.authors), 'Unknown author'),
      coverImage: normalizeCoverImage(
        safeHints.coverImage
        || String(volumeInfo?.imageLinks?.thumbnail || volumeInfo?.imageLinks?.smallThumbnail || '').replace('http://', 'https://'),
      ),
    };
  }

  return {
    title: normalizeText(safeHints.title || metadata?.title, sourceBookId),
    author: normalizeText(safeHints.author || metadata?.authors?.[0]?.name, 'Unknown author'),
    coverImage: normalizeCoverImage(
      safeHints.coverImage
      || metadata?.formats?.['image/jpeg']
      || metadata?.formats?.['image/png'],
    ),
  };
};

export const resolveBookOrThrow = async (bookIdParam, metadataHints = {}) => {
  const raw = String(bookIdParam || '').trim();
  if (!raw) {
    throw badRequest('Book id is required.');
  }

  // Prefer DB object id when supplied.
  if (/^[a-fA-F0-9]{24}$/.test(raw)) {
    const book = await Book.findById(raw).select('_id title author gutenbergId').lean();
    if (!book) {
      throw notFound('Book not found.');
    }
    return book;
  }

  const gutenbergId = parseGutenbergParam(raw);
  if (gutenbergId) {
    const book = await Book.findOne({ gutenbergId }).select('_id title author gutenbergId').lean();
    if (!book) {
      throw notFound('Book not found.');
    }
    return book;
  }

  const sourceMatch = raw.match(/^([a-z0-9_-]+):(.+)$/i);
  if (!sourceMatch) {
    throw badRequest('Invalid book id.');
  }

  const source = String(sourceMatch[1] || '').trim().toLowerCase();
  const sourceBookId = String(sourceMatch[2] || '').trim();
  if (!source || !sourceBookId || source === 'custom') {
    throw badRequest('Invalid book id.');
  }

  const hintedMetadata = {
    title: normalizeText(metadataHints?.title),
    author: normalizeText(metadataHints?.author),
    coverImage: normalizeCoverImage(metadataHints?.coverImage),
  };

  const existing = await Book.findOne({ source, sourceId: sourceBookId })
    .select('_id title author gutenbergId source sourceId coverImage')
    .lean();
  if (existing) {
    const needsMetadataUpdate = (
      (hintedMetadata.title && hintedMetadata.title !== existing.title)
      || (hintedMetadata.author && hintedMetadata.author !== existing.author)
      || (hintedMetadata.coverImage && hintedMetadata.coverImage !== existing.coverImage)
    );

    if (needsMetadataUpdate) {
      await Book.updateOne(
        { _id: existing._id },
        {
          $set: {
            title: hintedMetadata.title || existing.title,
            author: hintedMetadata.author || existing.author,
            coverImage: hintedMetadata.coverImage || existing.coverImage || '',
            lastAccessedAt: new Date(),
          },
        },
      );
      return {
        ...existing,
        title: hintedMetadata.title || existing.title,
        author: hintedMetadata.author || existing.author,
        coverImage: hintedMetadata.coverImage || existing.coverImage || '',
      };
    }

    return existing;
  }

  const existingSource = await BookSource.findOne({ source, source_book_id: sourceBookId })
    .select('canonical_book_id raw_metadata')
    .lean();

  const canonicalId = String(existingSource?.canonical_book_id || '').trim();
  const canonical = canonicalId
    ? await CanonicalBook.findOne({ canonical_book_id: canonicalId }).select('title author canonical_book_id').lean()
    : null;
  const derivedMetadata = extractSourceMetadata({
    source,
    sourceBookId,
    rawMetadata: existingSource?.raw_metadata,
    hints: hintedMetadata,
  });
  const syntheticGutenbergId = canonicalId
    ? buildCanonicalSyntheticGutenbergId(canonicalId)
    : buildSourceSyntheticGutenbergId(source, sourceBookId);

  const persisted = await Book.findOneAndUpdate(
    canonicalId ? { gutenbergId: syntheticGutenbergId } : { source, sourceId: sourceBookId },
    {
      $set: {
        title: normalizeText(hintedMetadata.title || canonical?.title || derivedMetadata.title, sourceBookId),
        author: normalizeText(hintedMetadata.author || canonical?.author || derivedMetadata.author, 'Unknown author'),
        source,
        sourceId: sourceBookId,
        coverImage: normalizeCoverImage(hintedMetadata.coverImage || derivedMetadata.coverImage),
        gutenbergId: syntheticGutenbergId,
        lastAccessedAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).select('_id title author gutenbergId source sourceId coverImage').lean();

  return persisted;
};
