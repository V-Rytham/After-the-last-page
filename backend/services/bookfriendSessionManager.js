import crypto from 'node:crypto';
import { BookfriendSession } from '../models/BookfriendSession.js';
import { log } from '../utils/logger.js';
import { UPSTREAM_ERROR_CATEGORIES } from '../errors/UpstreamServiceError.js';

/**
 * BookFriend session manager.
 *
 * Handles:
 * - Session creation and lifecycle tracking
 * - Stale session detection and recovery
 * - Session state persistence in database
 * - Recovery flow orchestration
 *
 * The main backend stores session metadata durably so it can recover
 * when BookFriend sessions expire or instance-switch occurs.
 */
export class BookfriendSessionManager {
  constructor(bookfriendClient) {
    this.client = bookfriendClient;
  }

  /**
   * Create a new session in both BookFriend and local database.
   */
  async createSession(userId, bookId, options = {}) {
    const { requestId = null, chapterProgress = null, localBookId = null, gutenbergId = null } = options;

    log('[BOOKFRIEND_SESSION_MANAGER] Creating session', {
      requestId,
      userId,
      bookId,
      chapterProgress,
    });

    try {
      // Start session in BookFriend
      const bookfriendResponse = await this.client.startSession(userId, bookId, {
        requestId,
        chapterProgress,
      });

      const sessionId = bookfriendResponse?.session_id;
      if (!sessionId) {
        throw new Error('BookFriend did not return session_id');
      }

      // Store session metadata in database
      const dbSession = await BookfriendSession.create({
        sessionId,
        userId,
        bookId,
        localBookId,
        gutenbergId,
        status: 'active',
        lastSuccessfulMessageAt: new Date(),
        requestCount: 1,
      });

      log('[BOOKFRIEND_SESSION_MANAGER] Session created successfully', {
        requestId,
        userId,
        bookId,
        sessionId,
        dbSessionId: dbSession._id,
      });

      return {
        sessionId,
        status: 'active',
        dbId: dbSession._id,
      };
    } catch (error) {
      log('[BOOKFRIEND_SESSION_MANAGER] Session creation failed', {
        requestId,
        userId,
        bookId,
        error: error.message,
        category: error.category,
      });

      throw error;
    }
  }

  /**
   * Get current session metadata from database.
   */
  async getSession(sessionId, options = {}) {
    const { requestId = null } = options;

    try {
      const session = await BookfriendSession.findOne({ sessionId, status: { $ne: 'ended' } });

      if (!session) {
        log('[BOOKFRIEND_SESSION_MANAGER] Session not found in database', {
          requestId,
          sessionId,
        });
        return null;
      }

      return {
        sessionId: session.sessionId,
        userId: session.userId,
        bookId: session.bookId,
        localBookId: session.localBookId || null,
        gutenbergId: session.gutenbergId || null,
        status: session.status,
        lastSuccessfulMessageAt: session.lastSuccessfulMessageAt,
        isStale: session.status === 'stale',
      };
    } catch (error) {
      log('[BOOKFRIEND_SESSION_MANAGER] Error retrieving session', {
        requestId,
        sessionId,
        error: error.message,
      });

      throw error;
    }
  }

  /**
   * Mark session as stale with reason.
   */
  async markSessionStale(sessionId, reason = 'upstream_error', options = {}) {
    const { requestId = null } = options;

    try {
      await BookfriendSession.updateOne(
        { sessionId },
        {
          status: 'stale',
          staleReason: reason,
          updatedAt: new Date(),
        },
      );

      log('[BOOKFRIEND_SESSION_MANAGER] Session marked stale', {
        requestId,
        sessionId,
        reason,
      });
    } catch (error) {
      log('[BOOKFRIEND_SESSION_MANAGER] Error marking session stale', {
        requestId,
        sessionId,
        error: error.message,
      });
    }
  }

  /**
   * Handle 404 session error from BookFriend.
   *
   * Flow:
   * 1. Mark current session stale
   * 2. Create new BookFriend session
   * 3. Optionally restore minimal context
   * 4. Return recovery metadata to caller
   */
  async recoverFromStaleSession(userId, bookId, options = {}) {
    const { requestId = null, oldSessionId = null, chapterProgress = null } = options;

    log('[BOOKFRIEND_SESSION_MANAGER] Recovering from stale session', {
      requestId,
      userId,
      bookId,
      oldSessionId,
    });

    try {
      // Mark old session stale
      if (oldSessionId) {
        await this.markSessionStale(oldSessionId, 'session_not_found_404', { requestId });
      }

      // Create new session
      const newSession = await this.createSession(userId, bookId, {
        requestId,
        chapterProgress,
      });

      return {
        newSessionId: newSession.sessionId,
        recovered: true,
        warning: 'Previous conversation session expired and was recovered. You may need to provide context.',
      };
    } catch (error) {
      log('[BOOKFRIEND_SESSION_MANAGER] Session recovery failed', {
        requestId,
        userId,
        bookId,
        oldSessionId,
        error: error.message,
      });

      throw error;
    }
  }

  /**
   * Update session activity timestamp and message count.
   */
  async recordMessageSuccess(sessionId, options = {}) {
    const { requestId = null } = options;

    try {
      await BookfriendSession.updateOne(
        { sessionId },
        {
          lastSuccessfulMessageAt: new Date(),
          $inc: { requestCount: 1 },
          updatedAt: new Date(),
        },
      );

      log('[BOOKFRIEND_SESSION_MANAGER] Session activity recorded', {
        requestId,
        sessionId,
      });
    } catch (error) {
      log('[BOOKFRIEND_SESSION_MANAGER] Error recording session activity', {
        requestId,
        sessionId,
        error: error.message,
      });
    }
  }

  /**
   * End a session.
   */
  async endSession(sessionId, options = {}) {
    const { requestId = null } = options;

    log('[BOOKFRIEND_SESSION_MANAGER] Ending session', {
      requestId,
      sessionId,
    });

    try {
      // End in BookFriend (best effort)
      try {
        await this.client.endSession(sessionId, { requestId });
      } catch (error) {
        log('[BOOKFRIEND_SESSION_MANAGER] Warning: Failed to end session in BookFriend', {
          requestId,
          sessionId,
          error: error.message,
        });
        // Continue with database update even if BookFriend fails
      }

      // Mark as ended in database
      await BookfriendSession.updateOne(
        { sessionId },
        {
          status: 'ended',
          staleReason: 'manually_ended',
          updatedAt: new Date(),
        },
      );

      log('[BOOKFRIEND_SESSION_MANAGER] Session ended successfully', {
        requestId,
        sessionId,
      });
    } catch (error) {
      log('[BOOKFRIEND_SESSION_MANAGER] Error ending session', {
        requestId,
        sessionId,
        error: error.message,
      });

      throw error;
    }
  }

  /**
   * Get session inspection data for frontend synchronization.
   */
  async inspectSession(sessionId, options = {}) {
    const { requestId = null } = options;

    const dbSession = await BookfriendSession.findOne({ sessionId });

    if (!dbSession) {
      return {
        exists: false,
        sessionId,
        message: 'Session not found',
      };
    }

    return {
      exists: true,
      sessionId,
      status: dbSession.status,
      isStale: dbSession.status === 'stale',
      createdAt: dbSession.createdAt,
      lastActivity: dbSession.lastSuccessfulMessageAt,
      userId: dbSession.userId,
      bookId: dbSession.bookId,
      recoverable: dbSession.status === 'stale',
      requestCount: dbSession.requestCount,
    };
  }
}

/**
 * Create a configured session manager.
 */
export const createBookfriendSessionManager = (bookfriendClient) => {
  return new BookfriendSessionManager(bookfriendClient);
};
