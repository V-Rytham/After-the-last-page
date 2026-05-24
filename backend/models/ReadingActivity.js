import mongoose from 'mongoose';

const readingActivitySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  bookId: { type: String, required: true, index: true },
  bookTitle: { type: String, default: '', trim: true },
  eventType: {
    type: String,
    enum: ['BOOK_STARTED', 'BOOK_CONTINUED', 'PAGE_PROGRESS_UPDATED', 'SESSION_COMPLETED'],
    required: true,
    index: true,
  },
  pagesRead: { type: Number, default: 0, min: 0 },
  progressPercent: { type: Number, default: 0, min: 0, max: 100 },
  sessionDurationMs: { type: Number, default: 0, min: 0 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

readingActivitySchema.index({ userId: 1, createdAt: -1 });

export const ReadingActivity = mongoose.model('ReadingActivity', readingActivitySchema);
