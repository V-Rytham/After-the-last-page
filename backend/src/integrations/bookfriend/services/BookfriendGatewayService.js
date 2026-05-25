import { BookfriendSession } from '../../../../models/BookfriendSession.js';
import { normalizeGutenbergId, toBookfriendBookId } from '../transformers/bookIdTransformer.js';

export class BookfriendGatewayService {
  constructor({ client, healthMonitor, logger }) { this.client = client; this.healthMonitor = healthMonitor; this.logger = logger; }

  async start({ userId, body, requestId }) {
    const gutenbergId = await normalizeGutenbergId(body.bookId);
    const upstream = await this.client.start({ user_id: userId, book_id: toBookfriendBookId(gutenbergId), chapter_progress: body.chapterProgress }, requestId);
    await BookfriendSession.create({ sessionId: upstream.session_id, userId, bookId: `gutenberg:${gutenbergId}`, localBookId: String(body.bookId), gutenbergId, status: 'active' });
    this.logger.info('[BOOKFRIEND_GATEWAY] Session created', { requestId, userId, sessionId: upstream.session_id, bookId: body.bookId });
    this.healthMonitor.onSuccess();
    return { session_id: upstream.session_id, status: 'active' };
  }

  async message({ userId, body, requestId }) {
    const own = await BookfriendSession.findOne({ sessionId: body.sessionId, userId, status: { $ne: 'ended' } }).lean();
    this.logger.info('[BOOKFRIEND_GATEWAY] Session lookup', { requestId, userId, sessionId: body.sessionId, found: Boolean(own) });
    if (!own) throw new Error('Session not found for user');
    const upstream = await this.client.message({ session_id: body.sessionId, message: body.message, chapter_progress: body.chapterProgress }, requestId);
    await BookfriendSession.updateOne({ sessionId: body.sessionId }, { $set: { lastSuccessfulMessageAt: new Date() }, $inc: { requestCount: 1 } });
    this.healthMonitor.onSuccess();
    return { response: upstream.response, sessionActive: true };
  }

  async end({ userId, body, requestId }) {
    const own = await BookfriendSession.findOne({ sessionId: body.sessionId, userId, status: { $ne: 'ended' } }).lean();
    this.logger.info('[BOOKFRIEND_GATEWAY] Session lookup for end', { requestId, userId, sessionId: body.sessionId, found: Boolean(own) });
    if (!own) throw new Error('Session not found for user');
    await this.client.end({ session_id: body.sessionId }, requestId).catch(() => null);
    await BookfriendSession.updateOne({ sessionId: body.sessionId, userId }, { $set: { status: 'ended', staleReason: 'manually_ended' } });
    return { ended: true, session_id: body.sessionId };
  }

  async health(requestId) {
    try {
      const upstream = await this.client.health(requestId);
      this.healthMonitor.onSuccess();
      return { ok: true, upstream, integration: this.healthMonitor.snapshot() };
    } catch (error) {
      this.healthMonitor.onFailure();
      return { ok: false, error: error.message, integration: this.healthMonitor.snapshot() };
    }
  }
}
