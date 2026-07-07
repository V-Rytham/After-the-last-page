import mongoose from 'mongoose';
import { Book } from '../models/Book.js';
import { UserProgress } from '../models/UserProgress.js';
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

  // Meet only pairs readers to talk (text/voice/video) — it never serves book
  // content — so unlike BookFriend RAG or the in-app reader it does NOT require
  // the book to be public domain. Access is simply: authenticated + a resolvable
  // book. No Archive.org eligibility phone call is made here (that external check
  // was the root cause of production 403s and is irrelevant to a chat feature).
  const normalizedBookId = String(bookId || '').trim();
  const normalizedSource = String(source || '').trim().toLowerCase();
  const normalizedSourceBookId = String(sourceBookId || '').trim();

  // Direct join path: caller already resolved a concrete source + id.
  if (normalizedSource && normalizedSourceBookId) {
    return { access: true, mode: 'open' };
  }

  // Pre-flight / canonical-id path (per-book eligibility checks): only require
  // that the book resolves to a known canonical record.
  if (!normalizedBookId) {
    return { access: false, mode: 'invalid' };
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
