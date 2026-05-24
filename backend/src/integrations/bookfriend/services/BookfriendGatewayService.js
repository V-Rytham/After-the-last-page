import { BookfriendSession } from '../../../../models/BookfriendSession.js';
import { normalizeGutenbergId, toBookfriendBookId } from '../transformers/bookIdTransformer.js';

export class BookfriendGatewayService {
  constructor({ client, healthMonitor, logger }) { this.client = client; this.healthMonitor = healthMonitor; this.logger = logger; }

  async start({ userId, body, requestId }) {
    const gutenbergId = await normalizeGutenbergId(body.book_id);
    const upstream = await this.client.start({ user_id: userId, book_id: toBookfriendBookId(gutenbergId), chapter_progress: body.chapter_progress }, requestId);
    await BookfriendSession.create({ sessionId: upstream.session_id, userId, bookId: `gutenberg:${gutenbergId}`, localBookId: String(body.book_id), gutenbergId, status: 'active' });
    this.healthMonitor.onSuccess();
    return { session_id: upstream.session_id, status: 'active' };
  }

  async message({ userId, body, requestId }) {
    const own = await BookfriendSession.findOne({ sessionId: body.session_id, userId, status: { $ne: 'ended' } }).lean();
    if (!own) throw new Error('Session not found for user');
    const upstream = await this.client.message({ session_id: body.session_id, message: body.message, chapter_progress: body.chapter_progress }, requestId);
    await BookfriendSession.updateOne({ sessionId: body.session_id }, { $set: { lastSuccessfulMessageAt: new Date() }, $inc: { requestCount: 1 } });
    this.healthMonitor.onSuccess();
    return { response: upstream.response, sessionActive: true };
  }

  async end({ userId, body, requestId }) {
    await this.client.end({ session_id: body.session_id }, requestId).catch(() => null);
    await BookfriendSession.updateOne({ sessionId: body.session_id, userId }, { $set: { status: 'ended', staleReason: 'manually_ended' } });
    return { ended: true, session_id: body.session_id };
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
