import { checkMeetAccess, checkQuizAccess } from '../services/accessService.js';
import mongoose from 'mongoose';
import { buildSafeErrorBody } from '../utils/runtime.js';
import { isDegradedMode } from '../utils/degradedMode.js';

export const checkAccess = async (req, res) => {
  try {
    const bookId = String(req.query?.bookId || '').trim();
    if (!bookId) {
      return res.status(400).json({ message: 'bookId is required.' });
    }

    const context = String(req.query?.context || '').trim().toLowerCase();

    if (isDegradedMode()) {
      if (context === 'meet') {
        return res.json({ access: false, mode: 'degraded', fallback: true, message: 'Meet is unavailable in degraded mode.' });
      }

      return res.json({ access: true, mode: 'completed', fallback: true });
    }

    if (context === 'meet') {
      const result = await checkMeetAccess({ userId: req.user?._id, bookId });
      return res.json({ access: result.access, mode: result.mode });
    }

    const result = await checkQuizAccess({ userId: req.user?._id, bookId });
    return res.json({ access: result.access, mode: result.access ? 'completed' : 'none' });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json(buildSafeErrorBody('Failed to check access.', error));
  }
};

export const checkAccessBatch = async (req, res) => {
  try {
    const bookIds = Array.isArray(req.body?.bookIds) ? req.body.bookIds : [];
    const context = String(req.body?.context || '').trim().toLowerCase();
    if (!bookIds.length) {
      return res.status(400).json({ message: 'bookIds must be a non-empty array.' });
    }

    if (bookIds.length > 120) {
      return res.status(400).json({ message: 'Too many bookIds in one request.' });
    }

    const normalized = bookIds.map((id) => String(id || '').trim()).filter(Boolean);
    if (!normalized.length) {
      return res.status(400).json({ message: 'bookIds must be a non-empty array.' });
    }

    if (context !== 'meet' && normalized.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      return res.status(400).json({ message: 'One or more bookIds are invalid.' });
    }

    if (isDegradedMode()) {
      // In degraded mode we still report the requested ids, but the caller may choose to disable live matching.
      return res.json({ allowedBookIds: normalized, fallback: true });
    }

    let allowedBookIds = [];

    if (context === 'meet') {
      const checks = await Promise.allSettled(
        normalized.map(async (bookId) => {
          const result = await checkMeetAccess({ userId: req.user?._id, bookId });
          return result?.access ? bookId : null;
        }),
      );

      allowedBookIds = checks
        .map((entry) => (entry.status === 'fulfilled' ? entry.value : null))
        .filter(Boolean);
    } else {
      allowedBookIds = normalized;
    }

    return res.json({ allowedBookIds });
  } catch (error) {
    return res.status(500).json(buildSafeErrorBody('Failed to check access.', error));
  }
};
