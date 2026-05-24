export class BookfriendError extends Error {
  constructor(message, { code = 'BOOKFRIEND_ERROR', status = 500, details = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class BookfriendUnavailableError extends BookfriendError {
  constructor(message = 'BookFriend service unavailable', details = null) {
    super(message, { code: 'BOOKFRIEND_UNAVAILABLE', status: 503, details });
  }
}

export class InvalidBookIdError extends BookfriendError {
  constructor(message = 'Invalid book_id', details = null) {
    super(message, { code: 'INVALID_BOOK_ID', status: 400, details });
  }
}

export class SessionExpiredError extends BookfriendError {
  constructor(message = 'Session expired', details = null) {
    super(message, { code: 'SESSION_EXPIRED', status: 404, details });
  }
}

export class ServiceTimeoutError extends BookfriendError {
  constructor(message = 'BookFriend request timeout', details = null) {
    super(message, { code: 'SERVICE_TIMEOUT', status: 504, details });
  }
}

export class ValidationError extends BookfriendError {
  constructor(message = 'Validation failed', details = null) {
    super(message, { code: 'VALIDATION_ERROR', status: 400, details });
  }
}
