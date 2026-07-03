import { BookThreadsService } from './bookThreadsService.js';
import { resolveBookOrThrow } from './bookResolver.js';
import { sendError, badRequest } from './httpErrors.js';
import { parseObjectId } from './validators.js';

const service = new BookThreadsService();

const toCleanString = (value, maxLen = 80) => String(value || '').trim().slice(0, maxLen);

const getIdentityFromRequest = (req, { required = false } = {}) => {
  const userId = toCleanString(req.body?.userId || req.headers['x-user-id'] || req.query?.userId, 80);
  const displayName = toCleanString(req.body?.displayName || req.headers['x-display-name'] || req.query?.displayName, 60);

  if (required && (!userId || !displayName)) {
    throw badRequest('userId and displayName are required.');
  }

  return {
    userId,
    displayName,
  };
};

const sendSuccess = (res, data, statusCode = 200) => res.status(statusCode).json({ success: true, data, error: null });

const getBookMetadataHints = (req) => ({
  title: toCleanString(req.body?.bookTitle || req.query?.title, 240),
  author: toCleanString(req.body?.bookAuthor || req.query?.author, 240),
  coverImage: toCleanString(req.body?.bookCoverImage || req.query?.coverImage, 2000),
});

export const createThread = async (req, res) => {
  try {
    const identity = getIdentityFromRequest(req, { required: true });
    const book = await resolveBookOrThrow(req.params.bookId, getBookMetadataHints(req));
    console.warn('[THREADS] create request received', {
      bookId: String(book._id),
      userId: identity.userId,
      displayName: identity.displayName,
    });

    const payload = await service.createThread({
      bookId: book._id,
      userId: identity.userId,
      displayName: identity.displayName,
      title: req.body?.title,
      content: req.body?.content,
      chapterReference: req.body?.chapterReference,
    });

    console.warn('[THREADS] create response sent', { threadId: payload?._id, bookId: payload?.bookId });
    return sendSuccess(res, payload, 201);
  } catch (error) {
    return sendError(res, error, 'Unable to create thread.');
  }
};

export const listThreadsByBook = async (req, res) => {
  try {
    const book = await resolveBookOrThrow(req.params.bookId, getBookMetadataHints(req));
    const payload = await service.listThreadsByBook({ bookId: book._id, query: req.query });
    return sendSuccess(res, payload);
  } catch (error) {
    return sendError(res, error, 'Unable to fetch threads.');
  }
};

export const searchThreads = async (req, res) => {
  try {
    const payload = await service.searchThreads({ query: req.query });
    return sendSuccess(res, payload);
  } catch (error) {
    return sendError(res, error, 'Unable to search threads.');
  }
};

export const getThread = async (req, res) => {
  try {
    const threadId = parseObjectId(req.params.threadId, 'thread id');
    const payload = await service.getThreadById({ threadId });
    return sendSuccess(res, payload);
  } catch (error) {
    return sendError(res, error, 'Unable to fetch thread.');
  }
};

export const listMessages = async (req, res) => {
  try {
    const threadId = parseObjectId(req.params.threadId, 'thread id');
    const payload = await service.listMessages({ threadId, query: req.query });
    return sendSuccess(res, payload);
  } catch (error) {
    return sendError(res, error, 'Unable to fetch messages.');
  }
};

export const addMessage = async (req, res) => {
  try {
    const identity = getIdentityFromRequest(req, { required: true });
    const threadId = parseObjectId(req.params.threadId, 'thread id');

    const parentMessageIdRaw = req.body?.parentMessageId ? String(req.body.parentMessageId).trim() : '';
    const parentMessageId = parentMessageIdRaw ? parseObjectId(parentMessageIdRaw, 'parent message id') : null;

    const payload = await service.addMessage({
      threadId,
      userId: identity.userId,
      displayName: identity.displayName,
      content: req.body?.content,
      parentMessageId,
    });

    return sendSuccess(res, payload, 201);
  } catch (error) {
    return sendError(res, error, 'Unable to add message.');
  }
};

export const toggleThreadLike = async (req, res) => {
  try {
    const identity = getIdentityFromRequest(req, { required: true });
    const threadId = parseObjectId(req.params.threadId, 'thread id');
    const payload = await service.toggleThreadLike({ threadId, actorId: identity.userId });
    return sendSuccess(res, payload);
  } catch (error) {
    return sendError(res, error, 'Unable to like thread.');
  }
};

export const toggleMessageLike = async (req, res) => {
  try {
    const identity = getIdentityFromRequest(req, { required: true });
    const threadId = parseObjectId(req.params.threadId, 'thread id');
    const messageId = parseObjectId(req.params.messageId, 'message id');

    const payload = await service.toggleMessageLike({ threadId, messageId, actorId: identity.userId });
    return sendSuccess(res, payload);
  } catch (error) {
    return sendError(res, error, 'Unable to like message.');
  }
};
