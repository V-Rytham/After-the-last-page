import 'dotenv/config';

export const env = {
  port: Number(process.env.PORT || 10001),
  mongoUri: String(process.env.MONGODB_URI || '').trim(),
  googleBooksApiKey: String(process.env.GOOGLE_BOOKS_API_KEY || '').trim(),
  searchTimeoutMs: Number(process.env.SEARCH_TIMEOUT_MS || 4500),
  archiveTimeoutMs: Number(process.env.ARCHIVE_TIMEOUT_MS || 1800),
};
