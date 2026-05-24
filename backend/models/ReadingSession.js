import mongoose from 'mongoose';

const readingSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  bookId: { type: String, required: true, index: true },
  bookTitle: { type: String, default: '', trim: true },
  currentPage: { type: Number, default: 0, min: 0 },
  totalPages: { type: Number, default: 1, min: 1 },
  progressPercent: { type: Number, default: 0, min: 0, max: 100 },
  isFinished: { type: Boolean, default: false },
  firstOpenedAt: { type: Date, default: null },
  lastOpenedAt: { type: Date, default: null },
  totalReadingMs: { type: Number, default: 0, min: 0 },
  lastSessionDurationMs: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

readingSessionSchema.index({ userId: 1, bookId: 1 }, { unique: true });
readingSessionSchema.index({ userId: 1, lastOpenedAt: -1 });

export const ReadingSession = mongoose.model('ReadingSession', readingSessionSchema);
