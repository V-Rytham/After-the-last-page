import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Book } from '../models/Book.js';
import { CanonicalBook } from '../models/CanonicalBook.js';
import { BookSource } from '../models/BookSource.js';
import { log } from '../utils/logger.js';
import { UpstreamServiceError, UPSTREAM_ERROR_CATEGORIES } from '../errors/UpstreamServiceError.js';

/**
 * Refactored agent controller for BookFriend integration.
 *
 * Architecture:
 * - NO fallback logic
 * - NO local session store
 * - STRICT microservice ownership
 * - EXPLICIT error handling
 * - STRUCTURED observability
 *
 * Session flow:
 * 1. Frontend calls /api/agent/start -> Creates BookFriend session + DB record
 * 2. Frontend calls /api/agent/message -> Sends message, handles 404 with recovery
 * 3. Frontend calls /api/agent/end -> Ends session in BookFriend + marks ended in DB
 */

const parseBookId = (bookId) => {
  const raw = String(bookId || '').trim();
  const composite = raw.match(/^([a-z0-9_-]+):(.+)$/i);
  if (composite) {
    const [, sourceRaw, sourceIdRaw] = composite;
    const source = String(sourceRaw || '').trim().toLowerCase();
    const sourceId = String(sourceIdRaw || '').trim();
    if (source === 'gutenberg' && /^\d+$/.test(sourceId)) {
      return { gutenbergId: Number.parseInt(sourceId, 10) };
    }
  }

  const gutenbergMatch = raw.match(/^g?(\d+)$/i);
  if (gutenbergMatch) {
    return { gutenbergId: Number.parseInt(gutenbergMatch[1], 10) };
  }

  if (mongoose.Types.ObjectId.isValid(raw)) {
    return { _id: raw };
  }


  return null;
};

const findBook = async (bookId) => {
  const query = parseBookId(bookId);
  if (!query) {
    return null;
  }

  return Book.findOne(query)
    .select('title author gutenbergId')
    .lean();
};

const resolveGutenbergIdForAgent = async (bookId) => {
  const raw = String(bookId || '').trim();
  if (!raw) return null;

  // Accept composite ids directly.
  const composite = raw.match(/^([a-z0-9_-]+):(.+)$/i);
  if (composite) {
    const [, sourceRaw, sourceIdRaw] = composite;
    const source = String(sourceRaw || '').trim().toLowerCase();
    const sourceId = String(sourceIdRaw || '').trim();
    if ((source === 'gutenberg' || source === 'gutendex') && /^\d+$/.test(sourceId)) {
      return Number.parseInt(sourceId, 10);
    }
  }

  // If it looks like a Mongo ObjectId, it might be either a local Book _id or a canonical_book_id.
  if (mongoose.Types.ObjectId.isValid(raw)) {
    const localBook = await Book.findById(raw).select('gutenbergId').lean();
    if (localBook?.gutenbergId != null) return Number(localBook.gutenbergId);

    const canonical = await CanonicalBook.findOne({ canonical_book_id: raw }).select('canonical_book_id').lean();
    if (canonical?.canonical_book_id) {
      const gutenbergSource = await BookSource.findOne({ canonical_book_id: raw, source: 'gutendex' })
        .select('source_book_id')
        .lean();
      const sourceId = String(gutenbergSource?.source_book_id || '').trim();
      if (/^\d+$/.test(sourceId)) return Number.parseInt(sourceId, 10);
    }
  }

  return null;
};

const validateStartPayload = (body) => {
  const bookId = String(body?.book_id || '').trim();
  if (!bookId) {
    const error = new Error('book_id is required.');
    error.statusCode = 400;
    throw error;
  }

  const chapterProgress = Number.parseInt(String(body?.chapter_progress ?? ''), 10);
  if (body?.chapter_progress != null && (!Number.isFinite(chapterProgress) || chapterProgress < 0 || chapterProgress > 10_000)) {
    const error = new Error('chapter_progress must be a valid non-negative integer.');
    error.statusCode = 400;
    throw error;
  }
};

const validateMessagePayload = (body) => {
  const sessionId = String(body?.session_id || '').trim();
  const message = String(body?.message || '').trim();
  if (!sessionId || !message) {
    const error = new Error('session_id and message are required.');
    error.statusCode = 400;
    throw error;
  }
  if (message.length > 2_000) {
    const error = new Error('message is too large.');
    error.statusCode = 400;
    throw error;
  }
};

const validateEndPayload = (body) => {
  const sessionId = String(body?.session_id || '').trim();
  if (!sessionId) {
    const error = new Error('session_id is required.');
    error.statusCode = 400;
    throw error;
  }
};

/**
 * Format error response for client.
 * Includes actionable error metadata.
 */
const formatErrorResponse = (error, requestId) => {
  const response = {
    error: error.message || 'Unknown error',
    requestId,
    category: error.category || 'UNKNOWN_ERROR',
    timestamp: new Date().toISOString(),
  };

  if (error.category === UPSTREAM_ERROR_CATEGORIES.SESSION_NOT_FOUND) {
    response.sessionExpired = true;
    response.suggestion = 'Session has expired. Start a new conversation.';
  }

  if (error.category === UPSTREAM_ERROR_CATEGORIES.UPSTREAM_TIMEOUT) {
    response.suggestion = 'Request took too long. Please try again.';
  }

  if (error.category === UPSTREAM_ERROR_CATEGORIES.NETWORK_ERROR) {
    response.suggestion = 'Service is temporarily unavailable. Please try again.';
  }

  return response;
};

/**
 * START SESSION
 * POST /api/agent/start
 *
 * Creates a new BookFriend session and stores metadata in database.
 * Session is owned by BookFriend; metadata tracked locally.
 */
export const startAgentSession = async (req, res) => {
  const requestId = req.requestId || crypto.randomUUID();

  try {
    log('[AGENT_CONTROLLER] Start session request', {
      requestId,
      userId: req.user?._id?.toString(),
      bookId: req.body?.book_id,
    });

    // Validate request
    validateStartPayload(req.body || {});

    const { book_id: bookId, chapter_progress: chapterProgress } = req.body || {};
    const userId = req.user?._id?.toString() || req.user?.anonymousId;

    if (!userId || !bookId) {
      return res.status(400).json({
        error: 'book_id and authentication required.',
        requestId,
      });
    }

    const gutenbergId = await resolveGutenbergIdForAgent(bookId);
    if (!gutenbergId) {
      return res.status(404).json({
        error: 'Book not found.',
        requestId,
        bookId,
      });
    }

    const bookfriendBookId = `gutenberg:${gutenbergId}`;

    // Get BookFriend client and session manager from app
    const { bookfriendClient, sessionManager } = req.app.locals;
    
    if (!bookfriendClient || !sessionManager) {
      const err = new Error('BookFriend services not initialized in app.locals');
      err.status = 500;
      throw err;
    }

    // Create session in BookFriend and persist metadata
    const sessionData = await sessionManager.createSession(userId, bookfriendBookId, {
      requestId,
      chapterProgress,
      localBookId: String(bookId),
      gutenbergId,
    });

    log('[AGENT_CONTROLLER] Session created successfully', {
      requestId,
      userId,
      bookId,
      sessionId: sessionData.sessionId,
    });

    res.status(201).json({
      session_id: sessionData.sessionId,
      status: 'active',
      requestId,
    });
  } catch (error) {
    log('[AGENT_CONTROLLER] Start session failed', {
      requestId,
      error: error.message,
      category: error.category,
      status: error.status,
    });

    const status = error.status || error.statusCode || 502;
    res.status(status).json(formatErrorResponse(error, requestId));
  }
};

/**
 * SEND MESSAGE
 * POST /api/agent/message
 *
 * Sends a message to BookFriend session.
 * Handles stale sessions by recovering intentionally.
 *
 * NO blind retries, NO local fallback.
 * Explicit recovery flow only on 404.
 */
export const sendAgentMessage = async (req, res) => {
  const requestId = req.requestId || crypto.randomUUID();

  try {
    log('[AGENT_CONTROLLER] Message request', {
      requestId,
      userId: req.user?._id?.toString(),
      sessionId: req.body?.session_id,
    });

    // Validate request
    validateMessagePayload(req.body || {});

    const { session_id: sessionId, message, chapter_progress: chapterProgress } = req.body || {};
    const userId = req.user?._id?.toString() || req.user?.anonymousId;

    // Get BookFriend client and session manager from app
    const { bookfriendClient, sessionManager } = req.app.locals;
    
    if (!bookfriendClient || !sessionManager) {
      const err = new Error('BookFriend services not initialized in app.locals');
      err.status = 500;
      throw err;
    }

    // Send message to BookFriend
    let response;
    try {
      response = await bookfriendClient.sendMessage(sessionId, message, {
        requestId,
        userId,
        chapterProgress,
      });

      // Record success in session metadata
      await sessionManager.recordMessageSuccess(sessionId, { requestId });

      log('[AGENT_CONTROLLER] Message sent successfully', {
        requestId,
        sessionId,
        userId,
      });

      res.json({
        response: response.response,
        sessionActive: true,
        requestId,
      });
    } catch (error) {
      // Handle 404 session not found with recovery
      if (error.category === UPSTREAM_ERROR_CATEGORIES.SESSION_NOT_FOUND) {
        log('[AGENT_CONTROLLER] Session not found, attempting recovery', {
          requestId,
          sessionId,
          userId,
        });

        // Get session metadata to recover with correct book_id
        const sessionMeta = await sessionManager.getSession(sessionId, { requestId });

        if (!sessionMeta) {
          // Session record doesn't exist either - cannot recover
          return res.status(404).json(formatErrorResponse(error, requestId));
        }

        // Recover session
        try {
          const recovery = await sessionManager.recoverFromStaleSession(userId, sessionMeta.bookId, {
            requestId,
            oldSessionId: sessionId,
            chapterProgress,
          });

          // Retry message once with new session
          const retryResponse = await bookfriendClient.sendMessage(recovery.newSessionId, message, {
            requestId: `${requestId}-recovery-retry`,
            userId,
            chapterProgress,
          });

          // Record success
          await sessionManager.recordMessageSuccess(recovery.newSessionId, { requestId });

          log('[AGENT_CONTROLLER] Session recovered and message sent', {
            requestId,
            oldSessionId: sessionId,
            newSessionId: recovery.newSessionId,
            userId,
          });

          res.json({
            response: retryResponse.response,
            sessionRecovered: true,
            newSessionId: recovery.newSessionId,
            warning: recovery.warning,
            requestId,
          });
        } catch (recoveryError) {
          // Recovery failed - return explicit error
          log('[AGENT_CONTROLLER] Session recovery failed', {
            requestId,
            sessionId,
            error: recoveryError.message,
          });

          const recoveryStatus = recoveryError.status || 502;
          res.status(recoveryStatus).json(formatErrorResponse(recoveryError, requestId));
        }
      } else {
        // Other upstream errors - fail explicitly
        const status = error.status || 502;
        res.status(status).json(formatErrorResponse(error, requestId));
      }
    }
  } catch (error) {
    log('[AGENT_CONTROLLER] Message request failed', {
      requestId,
      error: error.message,
      stack: error.stack,
    });

    const status = error.statusCode || 502;
    res.status(status).json({
      error: error.message || 'Unable to send message.',
      requestId,
    });
  }
};

/**
 * END SESSION
 * POST /api/agent/end
 *
 * Explicitly ends a session.
 * No fallback; fails if BookFriend unavailable.
 */
export const endAgentSession = async (req, res) => {
  const requestId = req.requestId || crypto.randomUUID();

  try {
    log('[AGENT_CONTROLLER] End session request', {
      requestId,
      sessionId: req.body?.session_id,
      userId: req.user?._id?.toString(),
    });

    validateEndPayload(req.body || {});

    const { session_id: sessionId } = req.body || {};
    
    const { sessionManager } = req.app.locals;
    
    if (!sessionManager) {
      const err = new Error('BookFriend services not initialized in app.locals');
      err.status = 500;
      throw err;
    }

    await sessionManager.endSession(sessionId, { requestId });

    log('[AGENT_CONTROLLER] Session ended successfully', {
      requestId,
      sessionId,
    });

    res.json({
      message: 'Session ended.',
      sessionId,
      requestId,
    });
  } catch (error) {
    log('[AGENT_CONTROLLER] End session failed', {
      requestId,
      sessionId: req.body?.session_id,
      error: error.message,
      category: error.category,
    });

    const status = error.status || error.statusCode || 502;
    res.status(status).json(formatErrorResponse(error, requestId));
  }
};

/**
 * INSPECT SESSION
 * GET /api/agent/session/:sessionId
 *
 * Returns session metadata for frontend synchronization.
 * Allows frontend to check if session is still valid/recoverable.
 */
export const inspectAgentSession = async (req, res) => {
  const requestId = req.requestId || crypto.randomUUID();

  try {
    const { sessionId } = req.params;

    log('[AGENT_CONTROLLER] Inspect session request', {
      requestId,
      sessionId,
      userId: req.user?._id?.toString(),
    });

    const { sessionManager } = req.app.locals;
    
    if (!sessionManager) {
      const err = new Error('BookFriend services not initialized in app.locals');
      err.status = 500;
      throw err;
    }
    const metadata = await sessionManager.inspectSession(sessionId, { requestId });

    res.json({
      ...metadata,
      requestId,
    });
  } catch (error) {
    log('[AGENT_CONTROLLER] Inspect session failed', {
      requestId,
      error: error.message,
    });

    res.status(500).json({
      error: error.message || 'Unable to inspect session.',
      requestId,
    });
  }
};
