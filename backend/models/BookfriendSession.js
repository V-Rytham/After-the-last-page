import mongoose from 'mongoose';

/**
 * BookfriendSession model for tracking BookFriend session lifecycle.
 *
 * Stores:
 * - session_id: The BookFriend session identifier (ephemeral)
 * - user_id: The user who owns this session
 * - book_id: The book being discussed
 * - status: One of 'active', 'stale', 'ended'
 * - created_at: When this session was created
 * - updated_at: Last update timestamp
 * - last_successful_message_at: When the last successful message was sent
 * - stale_reason: Why the session became stale (for observability)
 *
 * This allows the main backend to track BookFriend sessions durably
 * even though BookFriend stores them only in memory.
 */
const bookfriendSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    bookId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    // Optional: the book id the frontend/backend uses (e.g. Mongo ObjectId or composite route id).
    localBookId: {
      type: String,
      default: null,
      trim: true,
    },
    // Optional: denormalized Gutenberg id for debugging / analytics.
    gutenbergId: {
      type: Number,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'stale', 'ended'],
      default: 'active',
      index: true,
    },
    staleReason: {
      type: String,
      enum: [
        'manually_ended',
        'session_not_found_404',
        'upstream_error',
        'timeout',
        'explicit_invalidation',
      ],
      default: null,
    },
    lastSuccessfulMessageAt: {
      type: Date,
      default: null,
    },
    requestCount: {
      type: Number,
      default: 0,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: 'bookfriend_sessions',
    timestamps: true,
  },
);

// Index for finding active sessions by user+book
bookfriendSessionSchema.index({ userId: 1, bookId: 1, status: 1 });

// Auto-delete after 30 days
bookfriendSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2_592_000 });

export const BookfriendSession =
  mongoose.models.BookfriendSession || mongoose.model('BookfriendSession', bookfriendSessionSchema);
