import mongoose from 'mongoose';
import { BookThread } from '../../models/BookThread.js';
import { BookThreadMessage } from '../../models/BookThreadMessage.js';
import { badRequest, notFound } from './httpErrors.js';
import { parsePagination, sanitizeText } from './validators.js';

const deriveAuthorLabel = (record) => {
  const displayName = String(record?.displayName || '').trim();
  if (displayName) return displayName;

  const userId = String(record?.userId || '').trim();
  if (userId) return `Reader ${userId.slice(-4)}`;

  return 'Anonymous Reader';
};

const deriveUsername = () => '';

const normalizeId = (value) => (value ? String(value) : '');
const OBJECT_ID_HEX_RE = /^[a-fA-F0-9]{24}$/;

const toObjectIdOrNull = (value) => {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!OBJECT_ID_HEX_RE.test(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
};

const normalizeObjectIdList = (values) => {
  if (!Array.isArray(values)) return [];

  const seen = new Set();
  const normalized = [];

  for (const value of values) {
    const asString = String(value || '').trim();
    if (!asString || seen.has(asString)) continue;

    const objectId = toObjectIdOrNull(value);
    if (!objectId) continue;

    seen.add(asString);
    normalized.push(objectId);
  }

  return normalized;
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const uniqueObjectIdList = (values) => {
  const seen = new Set();
  const normalized = [];

  for (const value of values || []) {
    const objectId = toObjectIdOrNull(value);
    if (!objectId) continue;
    const asString = String(objectId);
    if (seen.has(asString)) continue;
    seen.add(asString);
    normalized.push(objectId);
  }

  return normalized;
};

const toThreadListItem = ({ thread, rootMessage }) => ({
  id: normalizeId(thread._id),
  _id: normalizeId(thread._id),
  bookId: normalizeId(thread.bookId),
  userId: normalizeId(thread.userId?._id || thread.userId),
  authorAnonId: deriveAuthorLabel(thread),
  authorUsername: deriveUsername(thread),
  title: thread.title,
  chapterReference: thread.chapterReference || '',
  content: rootMessage?.content || '',
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  lastMessageAt: thread.lastMessageAt,
  messageCount: Number(thread.messageCount || 0),
  likes: Number(thread.likes || 0),
  likedBy: Array.isArray(thread.likedBy) ? thread.likedBy.map(normalizeId) : [],
  rootMessageId: normalizeId(thread.rootMessageId),
});

const toThreadDetail = ({ thread, rootMessage }) => ({
  ...toThreadListItem({ thread, rootMessage }),
});

const toMessageDto = (message) => ({
  id: normalizeId(message._id),
  _id: normalizeId(message._id),
  threadId: normalizeId(message.threadId),
  userId: normalizeId(message.userId?._id || message.userId),
  authorAnonId: deriveAuthorLabel(message),
  authorUsername: deriveUsername(message),
  content: message.content,
  parentMessageId: normalizeId(message.parentMessageId),
  createdAt: message.createdAt,
  likes: Number(message.likes || 0),
  likedBy: Array.isArray(message.likedBy) ? message.likedBy.map(normalizeId) : [],
});

const isStandaloneTransactionError = (error) => {
  const message = String(error?.message || error?.cause?.message || '').toLowerCase();
  return message.includes('transaction numbers are only allowed') || message.includes('replica set member or mongos');
};

export class BookThreadsService {
  async searchThreads({ query }) {
    const raw = String(query?.q || '').trim();
    if (!raw) {
      return { items: [] };
    }

    const regex = new RegExp(escapeRegex(raw), 'i');

    const [threadMatches, messageMatches] = await Promise.all([
      BookThread.find({
        $or: [
          { title: regex },
          { displayName: regex },
        ],
      })
        .select('_id')
        .lean(),
      BookThreadMessage.find({
        $or: [
          { content: regex },
          { displayName: regex },
        ],
      })
        .select('threadId')
        .limit(200)
        .lean(),
    ]);

    const threadIds = uniqueObjectIdList([
      ...threadMatches.map((thread) => thread?._id),
      ...messageMatches.map((message) => message?.threadId),
    ]);

    if (!threadIds.length) {
      return { items: [] };
    }

    const threads = await BookThread.find({ _id: mongoose.trusted({ $in: threadIds }) })
      .sort({ lastMessageAt: -1, _id: -1 })
      .limit(20)
      .lean();

    const rootMessageIds = normalizeObjectIdList(threads.map((thread) => thread.rootMessageId));
    const roots = rootMessageIds.length
      ? await BookThreadMessage.find({ _id: mongoose.trusted({ $in: rootMessageIds }) }).select('_id content').lean()
      : [];
    const rootById = new Map(roots.map((msg) => [String(msg._id), msg]));

    return {
      items: threads.map((thread) => toThreadListItem({
        thread,
        rootMessage: rootById.get(String(thread.rootMessageId)) || null,
      })),
    };
  }

  async createThread({ bookId, userId, displayName, title, content, chapterReference }) {
    const sanitizedTitle = sanitizeText(title, 100);
    const sanitizedContent = sanitizeText(content, 3000);
    const sanitizedReference = sanitizeText(chapterReference, 80);

    if (!String(userId || '').trim() || !String(displayName || '').trim()) {
      throw badRequest('userId and displayName are required.');
    }

    if (!sanitizedTitle || sanitizedTitle.length < 3) {
      throw badRequest('Thread title must be at least 3 characters.');
    }

    if (!sanitizedContent) {
      throw badRequest('Thread content is required.');
    }

    const createThreadWithoutTransaction = async () => {
      const createdThread = await BookThread.create({
        bookId,
        userId,
        displayName,
        title: sanitizedTitle,
        chapterReference: sanitizedReference,
        rootMessageId: null,
        messageCount: 0,
        lastMessageAt: new Date(),
        likes: 0,
        likedBy: [],
      });

      let createdRoot;
      try {
        createdRoot = await BookThreadMessage.create({
          threadId: createdThread._id,
          userId,
          displayName,
          content: sanitizedContent,
          parentMessageId: null,
          likes: 0,
          likedBy: [],
        });
      } catch (error) {
        await BookThread.deleteOne({ _id: createdThread._id });
        throw error;
      }

      await BookThread.updateOne(
        { _id: createdThread._id },
        {
          $set: {
            rootMessageId: createdRoot._id,
            messageCount: 1,
            lastMessageAt: createdRoot.createdAt,
          },
        },
      );

      console.warn('[THREADS] db write completed', { threadId: String(createdThread._id), strategy: 'rollback-safe' });

      const hydratedThread = await BookThread.findById(createdThread._id).lean();
      const rootMessage = await BookThreadMessage.findById(createdRoot._id).lean();
      return toThreadDetail({ thread: hydratedThread, rootMessage });
    };

    const session = await mongoose.startSession();
    try {
      let createdThread;
      let createdRoot;

      try {
        await session.withTransaction(async () => {
          createdThread = await BookThread.create([{
            bookId,
            userId,
            displayName,
            title: sanitizedTitle,
            chapterReference: sanitizedReference,
            rootMessageId: null,
            messageCount: 0,
            lastMessageAt: new Date(),
            likes: 0,
            likedBy: [],
          }], { session }).then((docs) => docs[0]);

          createdRoot = await BookThreadMessage.create([{
            threadId: createdThread._id,
            userId,
            displayName,
            content: sanitizedContent,
            parentMessageId: null,
            likes: 0,
            likedBy: [],
          }], { session }).then((docs) => docs[0]);

          await BookThread.updateOne(
            { _id: createdThread._id },
            {
              $set: {
                rootMessageId: createdRoot._id,
                messageCount: 1,
                lastMessageAt: createdRoot.createdAt,
              },
            },
            { session },
          );
        });
      } catch (error) {
        if (isStandaloneTransactionError(error)) {
          return await createThreadWithoutTransaction();
        }
        throw error;
      }

      console.warn('[THREADS] db write completed', { threadId: String(createdThread._id), strategy: 'transaction' });
      const hydratedThread = await BookThread.findById(createdThread._id).lean();
      const rootMessage = await BookThreadMessage.findById(createdRoot._id).lean();
      return toThreadDetail({ thread: hydratedThread, rootMessage });
    } finally {
      session.endSession();
    }
  }

  async listThreadsByBook({ bookId, query }) {
    const { page, limit, skip } = parsePagination(query, { defaultLimit: 25, maxLimit: 50 });

    const [threads, total] = await Promise.all([
      BookThread.find({ bookId })
        .sort({ lastMessageAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      BookThread.countDocuments({ bookId }),
    ]);

    const rootMessageIds = normalizeObjectIdList(threads.map((thread) => thread.rootMessageId));
    const rootMessagesQuery = { _id: mongoose.trusted({ $in: rootMessageIds }) };

    const roots = rootMessageIds.length
      ? await BookThreadMessage.find(rootMessagesQuery).select('_id content').lean()
      : [];
    const rootById = new Map(roots.map((msg) => [String(msg._id), msg]));

    const items = threads.map((thread) => toThreadListItem({
      thread,
      rootMessage: rootById.get(String(thread.rootMessageId)) || null,
    }));

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async getThreadById({ threadId }) {
    const thread = await BookThread.findById(threadId).lean();
    if (!thread) {
      throw notFound('Thread not found.');
    }

    const rootMessage = thread.rootMessageId
      ? await BookThreadMessage.findById(thread.rootMessageId).select('_id content createdAt').lean()
      : null;

    return toThreadDetail({ thread, rootMessage });
  }

  async listMessages({ threadId, query }) {
    const { page, limit, skip } = parsePagination(query, { defaultLimit: 50, maxLimit: 100 });
    const order = String(query?.order || 'asc').toLowerCase() === 'desc' ? -1 : 1;

    const [threadExists, items, total] = await Promise.all([
      BookThread.exists({ _id: threadId }),
      BookThreadMessage.find({ threadId })
        .sort({ createdAt: order, _id: order })
        .skip(skip)
        .limit(limit)
        .lean(),
      BookThreadMessage.countDocuments({ threadId }),
    ]);

    if (!threadExists) {
      throw notFound('Thread not found.');
    }

    return {
      items: items.map(toMessageDto),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async addMessage({ threadId, userId, displayName, content, parentMessageId = null }) {
    const sanitizedContent = sanitizeText(content, 1200);
    if (!sanitizedContent) {
      throw badRequest('Message content is required.');
    }

    const thread = await BookThread.findById(threadId).select('_id rootMessageId').lean();
    if (!thread) {
      throw notFound('Thread not found.');
    }

    let parent = null;
    if (parentMessageId) {
      parent = await BookThreadMessage.findById(parentMessageId).select('_id threadId').lean();
      if (!parent) {
        throw badRequest('Parent message does not exist.');
      }
      if (String(parent.threadId) !== String(threadId)) {
        throw badRequest('Parent message does not belong to this thread.');
      }
    }

    const message = await BookThreadMessage.create({
      threadId,
      userId,
      displayName,
      content: sanitizedContent,
      parentMessageId: parent ? parent._id : null,
      likes: 0,
      likedBy: [],
    });

    await BookThread.updateOne(
      { _id: threadId },
      {
        $inc: { messageCount: 1 },
        $set: { lastMessageAt: message.createdAt },
      },
    );

    const hydrated = await BookThreadMessage.findById(message._id).lean();

    return toMessageDto(hydrated);
  }

  async toggleThreadLike({ threadId, actorId }) {
    const thread = await BookThread.findById(threadId).select('likes likedBy').lean();
    if (!thread) {
      throw notFound('Thread not found.');
    }

    const actorKey = String(actorId);
    const likedBy = Array.isArray(thread.likedBy) ? thread.likedBy.map(String) : [];
    const hasLiked = likedBy.includes(actorKey);

    const update = hasLiked
      ? { $pull: { likedBy: actorId }, $inc: { likes: -1 } }
      : { $addToSet: { likedBy: actorId }, $inc: { likes: 1 } };

    await BookThread.updateOne({ _id: threadId }, update);
    const updated = await BookThread.findById(threadId).lean();
    const rootMessage = updated?.rootMessageId
      ? await BookThreadMessage.findById(updated.rootMessageId).select('_id content').lean()
      : null;
    return toThreadDetail({ thread: updated, rootMessage });
  }

  async toggleMessageLike({ threadId, messageId, actorId }) {
    const message = await BookThreadMessage.findById(messageId).select('threadId likes likedBy').lean();
    if (!message) {
      throw notFound('Message not found.');
    }
    if (String(message.threadId) !== String(threadId)) {
      throw badRequest('Message does not belong to this thread.');
    }

    const actorKey = String(actorId);
    const likedBy = Array.isArray(message.likedBy) ? message.likedBy.map(String) : [];
    const hasLiked = likedBy.includes(actorKey);

    const update = hasLiked
      ? { $pull: { likedBy: actorId }, $inc: { likes: -1 } }
      : { $addToSet: { likedBy: actorId }, $inc: { likes: 1 } };

    await BookThreadMessage.updateOne({ _id: messageId }, update);
    const updated = await BookThreadMessage.findById(messageId).lean();
    return toMessageDto(updated);
  }
}
