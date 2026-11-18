export interface AppConfig {
  port: number;
  databasePath: string;
  jellyfinUrl?: string;
  seerrUrl?: string;
  seerrApiKey?: string;
  sessionSecret: string;
  sessionTtlDays: number;
  secureCookies?: boolean;
}

const DEFAULT_DEV_SECRET = 'dev_insecure_default_secret_key_at_least_32_characters_long_12345';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawPort = env.PORT;
  const port = rawPort ? parseInt(rawPort, 10) : 3000;
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT environment variable: ${rawPort}`);
  }

  const databasePath = env.DATABASE_PATH || './data/home-media.db';
  const jellyfinUrl = env.JELLYFIN_URL?.trim() || undefined;
  const seerrUrl = env.SEERR_URL?.trim() || undefined;
  const seerrApiKey = env.SEERR_API_KEY?.trim() || undefined;

  const rawSecret = env.SESSION_SECRET?.trim();
  const isProduction = env.NODE_ENV === 'production';

  if (isProduction) {
    if (!rawSecret || rawSecret.length < 32) {
      throw new Error('SESSION_SECRET must be at least 32 characters long in production');
    }
  }

  const sessionSecret = rawSecret || DEFAULT_DEV_SECRET;

  const rawTtl = env.SESSION_TTL_DAYS?.trim();
  const sessionTtlDays = rawTtl ? parseInt(rawTtl, 10) : 7;
  if (isNaN(sessionTtlDays) || sessionTtlDays <= 0) {
    throw new Error(`Invalid SESSION_TTL_DAYS environment variable: ${rawTtl}`);
  }

  const secureCookies =
    env.SECURE_COOKIES === 'true' || (isProduction && env.SECURE_COOKIES !== 'false');

  return {
    port,
    databasePath,
    jellyfinUrl,
    seerrUrl,
    seerrApiKey,
    sessionSecret,
    sessionTtlDays,
    secureCookies,
  };
}
