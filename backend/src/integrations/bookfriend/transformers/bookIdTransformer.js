import mongoose from 'mongoose';
import { Book } from '../../../../models/Book.js';
import { CanonicalBook } from '../../../../models/CanonicalBook.js';
import { BookSource } from '../../../../models/BookSource.js';
import { InvalidBookIdError } from '../errors/BookfriendErrors.js';

export const normalizeGutenbergId = async (input) => {
  const raw = String(input || '').trim();
  const direct = raw.match(/^(?:g|gutenberg:)?(\d+)$/i);
  if (direct) return Number.parseInt(direct[1], 10);

  if (!mongoose.Types.ObjectId.isValid(raw)) throw new InvalidBookIdError('book_id is not supported');

  const local = await Book.findById(raw).select('gutenbergId').lean();
  if (local?.gutenbergId != null) return Number(local.gutenbergId);

  const canonical = await CanonicalBook.findOne({ canonical_book_id: raw }).select('canonical_book_id').lean();
  if (canonical?.canonical_book_id) {
    const source = await BookSource.findOne({ canonical_book_id: raw, source: 'gutendex' }).select('source_book_id').lean();
    if (/^\d+$/.test(String(source?.source_book_id || ''))) return Number.parseInt(String(source.source_book_id), 10);
  }

  throw new InvalidBookIdError('Could not resolve Gutenberg id from book_id');
};

export const toBookfriendBookId = (gutenbergId) => `gutenberg:${gutenbergId}`;
