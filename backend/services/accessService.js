import mongoose from 'mongoose';
import { Book } from '../models/Book.js';
import { UserProgress } from '../models/UserProgress.js';
import { canCreateArchiveRooms, splitCompositeSourceId } from './bookAggregationService.js';
import { CanonicalBook } from '../models/CanonicalBook.js';

export const resolveBookOrThrow = async (bookId) => {
  if (!mongoose.Types.ObjectId.isValid(bookId)) {
    const error = new Error('Invalid book reference.');
    error.statusCode = 400;
    throw error;
  }

  const book = await Book.findById(bookId).select('_id');
  if (!book) {
    const error = new Error('Book not found.');
    error.statusCode = 404;
    throw error;
  }

  return book;
};

export const checkMeetAccess = async ({ userId, bookId, source, sourceBookId }) => {
  if (!userId) {
    const error = new Error('Unauthorized.');
    error.statusCode = 401;
    throw error;
  }

  const meetAllowRestricted = String(process.env.MEET_ALLOW_RESTRICTED || '').trim().toLowerCase() === 'true';
  if (meetAllowRestricted) {
    return { access: true, mode: 'override' };
  }

  const normalizedBookId = String(bookId || '').trim();
  const normalizedSource = String(source || '').trim().toLowerCase();
  const normalizedSourceBookId = String(sourceBookId || '').trim();

  if (normalizedSource && normalizedSourceBookId) {
    if (normalizedSource === 'archive' || normalizedSource === 'internetarchive') {
      const allowed = await canCreateArchiveRooms({ source: normalizedSource, sourceId: normalizedSourceBookId });
      if (!allowed) {
        return {
          access: false,
          mode: 'restricted',
          message: 'Live reading rooms are only available for open-access books.',
        };
      }
    }
    return { access: true, mode: 'open' };
  }

  if (!normalizedBookId) {
    return { access: false, mode: 'invalid' };
  }

  const parsed = splitCompositeSourceId(normalizedBookId);
  if (parsed?.source === 'archive' || parsed?.source === 'internetarchive') {
    const allowed = await canCreateArchiveRooms({ source: parsed.source, sourceId: parsed.sourceId });
    if (!allowed) {
      return {
        access: false,
        mode: 'restricted',
        message: 'Live reading rooms are only available for open-access books.',
      };
    }
  }

  const canonicalExists = await CanonicalBook.findOne({ canonical_book_id: normalizedBookId }).select('_id').lean();
  if (!canonicalExists) {
    return { access: false, mode: 'invalid', message: 'Select a valid book result to join Meet.' };
  }

  return { access: true, mode: 'open' };
};

export const grantMeetFallback = async ({ userId, bookId, reason }) => {
  if (!userId) {
    const error = new Error('Unauthorized.');
    error.statusCode = 401;
    throw error;
  }

  const normalizedBookId = String(bookId || '').trim();
  if (!normalizedBookId) {
    const error = new Error('bookId is required.');
    error.statusCode = 400;
    throw error;
  }

  // Backwards-compat no-op: Meet no longer requires fallback/unlock flows.
  const trimmedReason = String(reason || '').trim().slice(0, 180);
  void trimmedReason;
  return { ok: true, noop: true };
};
