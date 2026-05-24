import { ReadingSession } from '../models/ReadingSession.js';
import { ReadingActivity } from '../models/ReadingActivity.js';

const MIN_MEANINGFUL_MS = 45_000;
const MIN_ACTIVITY_PAGE_DELTA = 1;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const buildEventType = ({ existed, prevProgress, nextProgress, sessionDurationMs, pageDelta }) => {
  if (!existed && nextProgress > 0) return 'BOOK_STARTED';
  if (nextProgress >= 100 && prevProgress < 100) return 'SESSION_COMPLETED';
  if (sessionDurationMs >= MIN_MEANINGFUL_MS && pageDelta >= MIN_ACTIVITY_PAGE_DELTA) return 'BOOK_CONTINUED';
  if (pageDelta >= MIN_ACTIVITY_PAGE_DELTA) return 'PAGE_PROGRESS_UPDATED';
  return null;
};

export const upsertReadingProgress = async (req, res) => {
  try {
    const userId = req.user?._id;
    const bookId = String(req.body?.bookId || '').trim();
    const bookTitle = String(req.body?.bookTitle || '').trim();
    const currentPage = Math.max(0, Number(req.body?.currentPage) || 0);
    const totalPages = Math.max(1, Number(req.body?.totalPages) || 1);
    const progressPercent = clamp(Number(req.body?.progressPercent) || Math.round((currentPage / totalPages) * 100), 0, 100);
    const sessionDurationMs = Math.max(0, Number(req.body?.sessionDurationMs) || 0);

    if (!bookId) return res.status(400).json({ message: 'bookId is required.' });

    const existing = await ReadingSession.findOne({ userId, bookId });
    const prevProgress = Number(existing?.progressPercent || 0);
    const prevPage = Number(existing?.currentPage || 0);
    const pageDelta = Math.max(0, currentPage - prevPage);

    const update = {
      bookTitle,
      currentPage,
      totalPages,
      progressPercent,
      isFinished: progressPercent >= 100,
      lastOpenedAt: new Date(),
      $inc: { totalReadingMs: sessionDurationMs },
      lastSessionDurationMs: sessionDurationMs,
    };

    if (!existing) update.firstOpenedAt = new Date();

    const session = await ReadingSession.findOneAndUpdate(
      { userId, bookId },
      { $set: update, $setOnInsert: { userId, bookId, firstOpenedAt: new Date() } },
      { upsert: true, new: true },
    );

    const eventType = buildEventType({
      existed: Boolean(existing),
      prevProgress,
      nextProgress: progressPercent,
      sessionDurationMs,
      pageDelta,
    });

    if (eventType) {
      await ReadingActivity.create({
        userId,
        bookId,
        bookTitle,
        eventType,
        pagesRead: pageDelta,
        progressPercent,
        sessionDurationMs,
      });
    }

    return res.json({ session, activityCreated: Boolean(eventType) });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to persist reading progress.' });
  }
};

export const getRecentReadingActivity = async (req, res) => {
  try {
    const userId = req.user?._id;
    const [activities, sessions] = await Promise.all([
      ReadingActivity.find({ userId }).sort({ createdAt: -1 }).limit(30).lean(),
      ReadingSession.find({ userId }).sort({ lastOpenedAt: -1 }).limit(100).lean(),
    ]);

    return res.json({ activities, sessions });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load recent reading activity.' });
  }
};
