const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getBookfriendConfig = () => ({
  baseUrl: String(process.env.BOOKFRIEND_SERVER_URL || 'http://127.0.0.1:5050').trim().replace(/\/$/, ''),
  timeoutMs: toInt(process.env.BOOKFRIEND_SERVICE_TIMEOUT_MS, 12000),
  retryCount: toInt(process.env.BOOKFRIEND_SERVICE_RETRY_COUNT, 1),
  healthFailureThreshold: toInt(process.env.BOOKFRIEND_HEALTH_FAILURE_THRESHOLD, 4),
});
