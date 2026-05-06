export const withTimeout = async (url, init = {}, timeoutMs = 4500) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

export const safeJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

export const asyncHandler = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (e) { next(e); }
};
