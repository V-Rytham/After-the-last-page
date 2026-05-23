const trimTrailingSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

const parseBool = (value, fallback = false) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
};

const normalizeBaseUrl = (value) => {
  const trimmed = trimTrailingSlash(value);
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

const MAX_NON_JSON_ERROR_CHARS = 2000;

const readJsonSafely = async (response) => {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    return response.json().catch(() => ({}));
  }

  const text = await response.text().catch(() => '');
  const snippet = text.length > MAX_NON_JSON_ERROR_CHARS ? `${text.slice(0, MAX_NON_JSON_ERROR_CHARS)}…` : text;
  const inferred = contentType.includes('text/html')
    ? 'Upstream service returned an HTML error page.'
    : 'Service returned a non-JSON response.';

  return {
    message: snippet || inferred,
    code: 'NON_JSON_UPSTREAM_RESPONSE',
    contentType,
  };
};

const serializeError = (error) => {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    statusCode: error.statusCode,
    payload: error.payload,
  };
};

export const createMicroserviceClient = ({ envBaseUrlKey, envTimeoutMsKey, envEnabledKey }) => {
  const baseUrl = normalizeBaseUrl(process.env[envBaseUrlKey]);
  const enabled = parseBool(process.env[envEnabledKey], Boolean(baseUrl));
  const timeoutMs = Number(process.env[envTimeoutMsKey] || 60_000);

  const shouldRetry = ({ method, statusCode, error }) => {
    const normalizedMethod = String(method || '').toUpperCase();
    const isIdempotent = normalizedMethod === 'GET' || normalizedMethod === 'HEAD';
    if (!isIdempotent) return false;

    const status = Number(statusCode || error?.statusCode || 0);
    if (status === 502 || status === 503 || status === 504) return true;

    const message = String(error?.message || '').toLowerCase();
    return message.includes('fetch failed') || message.includes('network') || message.includes('aborted');
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const requestOnce = async (method, path, payload, extraHeaders = {}) => {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    if (!enabled || !baseUrl) {
      const err = new Error(`${envBaseUrlKey} is not configured.`);
      err.statusCode = 503;
      throw err;
    }

    const controller = new AbortController();
    const targetUrl = `${baseUrl}${path}`;
    const timeoutDurationMs = Number.isFinite(timeoutMs) ? timeoutMs : 60_000;
    const timeout = setTimeout(() => controller.abort(), timeoutDurationMs);
    console.info('[MICROSERVICE_PROXY] Request started', {
      method: normalizedMethod,
      route: path,
      targetUrl,
      timeoutMs: timeoutDurationMs,
    });
    try {
        const headers = { ...extraHeaders };
        const init = {
          method: normalizedMethod,
          headers,
          signal: controller.signal,
        };
        if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
          headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(payload || {});
        }

        const response = await fetch(targetUrl, {
          ...init,
        });

        const data = await readJsonSafely(response);
        console.info('[MICROSERVICE_PROXY] Response received', {
          method: normalizedMethod,
          route: path,
          targetUrl,
          status: response.status,
          ok: response.ok,
        });
        if (!response.ok) {
          const error = new Error(data?.message || `Upstream service request failed (${response.status}).`);
          error.statusCode = response.status;
          error.payload = data;
          console.error('[MICROSERVICE_PROXY] Request failed', {
            method: normalizedMethod,
            route: path,
            targetUrl,
            timeoutMs: timeoutDurationMs,
            status: response.status,
            parsedErrorResponse: data,
          });
          throw error;
        }

        return data;
    } catch (error) {
        console.error('[MICROSERVICE_PROXY] Request exception', {
          method: normalizedMethod,
          route: path,
          targetUrl,
          timeoutMs: timeoutDurationMs,
          error: serializeError(error),
        });
        throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  const request = async (method, path, payload, extraHeaders = {}) => {
    const maxRetries = 2;
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await requestOnce(method, path, payload, extraHeaders);
      } catch (error) {
        const statusCode = Number(error?.statusCode || 0);
        if (attempt >= maxRetries || !shouldRetry({ method, statusCode, error })) {
          throw error;
        }

        const delayMs = Math.min(4000, 350 * (2 ** attempt));
        console.warn('[MICROSERVICE_PROXY] Retrying request after upstream error', {
          method: String(method || 'GET').toUpperCase(),
          route: path,
          targetUrl: `${baseUrl}${path}`,
          attempt: attempt + 1,
          delayMs,
          statusCode,
        });
        attempt += 1;
        await sleep(delayMs);
      }
    }
  };

  return {
    isEnabled: () => enabled && Boolean(baseUrl),
    post: (path, payload, extraHeaders = {}) => request('POST', path, payload, extraHeaders),
    get: (path, extraHeaders = {}) => request('GET', path, null, extraHeaders),
  };
};
