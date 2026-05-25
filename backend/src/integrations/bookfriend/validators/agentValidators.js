import { ValidationError } from '../errors/BookfriendErrors.js';

export const validateStartPayload = (body) => {
  const bookId = String(body?.bookId || '').trim();
  if (!bookId) throw new ValidationError('book_id is required');
  if (body?.chapterProgress != null) {
    const cp = Number.parseInt(String(body.chapterProgress), 10);
    if (!Number.isFinite(cp) || cp < 0) throw new ValidationError('chapter_progress must be a non-negative integer');
  }
};

export const validateMessagePayload = (body) => {
  const sessionId = String(body?.sessionId || '').trim();
  const message = String(body?.message || '').trim();
  if (!sessionId || !message) throw new ValidationError('session_id and message are required');
  if (message.length > 2000) throw new ValidationError('message must be <= 2000 characters');
};

export const validateEndPayload = (body) => {
  if (!String(body?.sessionId || '').trim()) throw new ValidationError('session_id is required');
};
