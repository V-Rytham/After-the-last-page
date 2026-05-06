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

const readJsonSafely = async (response) => {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    return response.json().catch(() => ({}));
  }
  const text = await response.text().catch(() => '');
  return { message: text || 'Service returned a non-JSON response.' };
};

export const createMicroserviceClient = ({ envBaseUrlKey, envTimeoutMsKey, envEnabledKey, fallbackEnabled = false }) => {
  const baseUrl = normalizeBaseUrl(process.env[envBaseUrlKey]);
  const enabled = parseBool(process.env[envEnabledKey], Boolean(baseUrl));
  const timeoutMs = Number(process.env[envTimeoutMsKey] || 15_000);

  return {
    isEnabled: () => enabled && Boolean(baseUrl),
    async post(path, payload, extraHeaders = {}) {
      if (!enabled || !baseUrl) {
        const err = new Error(`${envBaseUrlKey} is not configured.`);
        err.statusCode = 503;
        throw err;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 15_000);
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...extraHeaders },
          body: JSON.stringify(payload || {}),
          signal: controller.signal,
        });

        const data = await readJsonSafely(response);
        if (!response.ok) {
          const error = new Error(data?.message || 'Microservice request failed.');
          error.statusCode = response.status;
          error.payload = data;
          throw error;
        }

        return data;
      } catch (error) {
        if (fallbackEnabled) {
          error.allowLocalFallback = true;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
};
