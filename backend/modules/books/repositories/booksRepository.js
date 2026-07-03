import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Book } from '../../../models/Book.js';
import { User } from '../../../models/User.js';
import { gutenbergCatalog } from '../../../seed/gutenbergCatalog.js';
import { fetchGutenbergMetadata } from '../../../utils/gutenbergReader.js';
import {
  aggregateBookSearch,
  readBookFromSource,
  SOURCE_NAMES,
  splitCompositeSourceId,
} from '../../../services/bookAggregationService.js';

const SOURCE_RECORD_PROJECTION = '_id title author gutenbergId source sourceId coverImage lastAccessedAt';
const SOURCE_SYNTHETIC_BASE = 2_000_000_000;

const normalizeSource = (value) => String(value || '').trim().toLowerCase();
const normalizeSourceId = (value) => String(value || '').trim();
const normalizeTitle = (value) => String(value || '').trim() || 'Untitled';
const normalizeAuthor = (value) => String(value || '').trim() || 'Unknown author';
const normalizeCoverImage = (value) => String(value || '').trim();

const deriveSyntheticGutenbergId = ({ source, sourceId, gutenbergId }) => {
  const numeric = Number(gutenbergId);
  if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;

  const hashInput = `${normalizeSource(source)}:${normalizeSourceId(sourceId)}`;
  const hash = crypto.createHash('sha1').update(hashInput).digest('hex');
  return SOURCE_SYNTHETIC_BASE + Number.parseInt(hash.slice(0, 8), 16);
};

export class BooksRepository {
  async listRecentBooks() {
    return Book.find({})
      .select(SOURCE_RECORD_PROJECTION)
      .sort({ lastAccessedAt: -1, _id: -1 })
      .lean();
  }

  async findBookByObjectId(routeId, projection = null) {
    if (!mongoose.Types.ObjectId.isValid(routeId)) return null;
    return Book.findById(routeId).select(projection);
  }

  async findBookByGutenbergId(gutenbergId) {
    return Book.findOne({ gutenbergId }).select(SOURCE_RECORD_PROJECTION).lean();
  }

  async findBookBySourceRef(source, sourceId) {
    const normalizedSource = normalizeSource(source);
    const normalizedSourceId = normalizeSourceId(sourceId);
    if (!normalizedSource || !normalizedSourceId) return null;

    return Book.findOne({ source: normalizedSource, sourceId: normalizedSourceId })
      .select(SOURCE_RECORD_PROJECTION)
      .lean();
  }

  async upsertMetadata({ gutenbergId, title, author }) {
    return Book.findOneAndUpdate(
      { gutenbergId },
      {
        $set: {
          title,
          author,
          gutenbergId,
          lastAccessedAt: new Date(),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).select('_id title author gutenbergId');
  }

  async upsertSourceBook({ source, sourceId, title, author, coverImage, gutenbergId = null }) {
    const normalizedSource = normalizeSource(source);
    const normalizedSourceId = normalizeSourceId(sourceId);
    if (!normalizedSource || !normalizedSourceId) return null;

    const resolvedGutenbergId = deriveSyntheticGutenbergId({
      source: normalizedSource,
      sourceId: normalizedSourceId,
      gutenbergId,
    });

    const existingBySource = await Book.findOne({
      source: normalizedSource,
      sourceId: normalizedSourceId,
    }).select('_id').lean();

    const filter = existingBySource
      ? { _id: existingBySource._id }
      : { gutenbergId: resolvedGutenbergId };

    const update = {
      $set: {
        title: normalizeTitle(title),
        author: normalizeAuthor(author),
        source: normalizedSource,
        sourceId: normalizedSourceId,
        lastAccessedAt: new Date(),
      },
      $setOnInsert: {
        gutenbergId: resolvedGutenbergId,
      },
    };

    const normalizedCoverImage = normalizeCoverImage(coverImage);
    if (normalizedCoverImage) {
      update.$set.coverImage = normalizedCoverImage;
    }

    return Book.findOneAndUpdate(filter, update, {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }).select(SOURCE_RECORD_PROJECTION).lean();
  }

  getCatalogEntries() {
    return Array.isArray(gutenbergCatalog) ? gutenbergCatalog : [];
  }

  async fetchRemoteMetadata(gutenbergId, { timeoutMs }) {
    return fetchGutenbergMetadata(gutenbergId, { timeoutMs });
  }

  async runAggregatedSearch(query) {
    return aggregateBookSearch(query);
  }

  async readBySource(params) {
    return readBookFromSource(params);
  }

  parseCompositeSourceId(value) {
    return splitCompositeSourceId(value);
  }

  getSourceNames() {
    return SOURCE_NAMES;
  }

  async getUserPreferredGenres(userId) {
    const user = await User.findById(userId).select('preferredGenres').lean();
    return Array.isArray(user?.preferredGenres) ? user.preferredGenres : [];
  }
}
