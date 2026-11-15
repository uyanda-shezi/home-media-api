import type { AppConfig } from '../config.js';

export type ServiceStatus = 'reachable' | 'unreachable' | 'unconfigured';

export interface ServiceCheckResult {
  status: ServiceStatus;
  version: string | null;
  error: string | null;
}

export interface ServicesHealth {
  jellyfin: ServiceCheckResult;
  seerr: ServiceCheckResult;
}

function sanitizeErrorMessage(err: unknown, secret?: string): string {
  let message = 'Unknown error';

  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.message.includes('timeout')) {
      return 'Request timed out after 3000ms';
    }

    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code) {
      if (cause.code === 'ECONNREFUSED') {
        return 'Connection refused (ECONNREFUSED)';
      }
      if (cause.code === 'ENOTFOUND') {
        return 'Host not found (ENOTFOUND)';
      }
      if (cause.code === 'ECONNRESET') {
        return 'Connection reset (ECONNRESET)';
      }
      return `Network error (${cause.code})`;
    }

    message = err.message;
  } else if (typeof err === 'string') {
    message = err;
  }

  // Ensure secret is never leaked
  if (secret && secret.length > 0 && message.includes(secret)) {
    message = message.replaceAll(secret, '[REDACTED]');
  }

  return message;
}

export async function probeJellyfin(url?: string): Promise<ServiceCheckResult> {
  if (!url) {
    return { status: 'unconfigured', version: null, error: null };
  }

  const endpoint = `${url.replace(/\/+$/, '')}/System/Info/Public`;

  try {
    const res = await fetch(endpoint, {
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      return {
        status: 'unreachable',
        version: null,
        error: `HTTP ${res.status} ${res.statusText}`,
      };
    }

    const data = (await res.json()) as { Version?: string };
    return {
      status: 'reachable',
      version: data?.Version ?? null,
      error: null,
    };
  } catch (err) {
    return {
      status: 'unreachable',
      version: null,
      error: sanitizeErrorMessage(err),
    };
  }
}

export async function probeSeerr(url?: string, apiKey?: string): Promise<ServiceCheckResult> {
  if (!url) {
    return { status: 'unconfigured', version: null, error: null };
  }

  const endpoint = `${url.replace(/\/+$/, '')}/api/v1/status`;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
  }

  try {
    const res = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      return {
        status: 'unreachable',
        version: null,
        error: `HTTP ${res.status} ${res.statusText}`,
      };
    }

    const data = (await res.json()) as { version?: string };
    return {
      status: 'reachable',
      version: data?.version ?? null,
      error: null,
    };
  } catch (err) {
    return {
      status: 'unreachable',
      version: null,
      error: sanitizeErrorMessage(err, apiKey),
    };
  }
}

export async function checkServicesPreflight(config: AppConfig): Promise<ServicesHealth> {
  const [jellyfinSettled, seerrSettled] = await Promise.allSettled([
    probeJellyfin(config.jellyfinUrl),
    probeSeerr(config.seerrUrl, config.seerrApiKey),
  ]);

  const jellyfin: ServiceCheckResult =
    jellyfinSettled.status === 'fulfilled'
      ? jellyfinSettled.value
      : {
          status: 'unreachable',
          version: null,
          error: sanitizeErrorMessage(jellyfinSettled.reason),
        };

  const seerr: ServiceCheckResult =
    seerrSettled.status === 'fulfilled'
      ? seerrSettled.value
      : {
          status: 'unreachable',
          version: null,
          error: sanitizeErrorMessage(seerrSettled.reason, config.seerrApiKey),
        };

  return { jellyfin, seerr };
}
