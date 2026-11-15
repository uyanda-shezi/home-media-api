export interface AppConfig {
  port: number;
  databasePath: string;
  jellyfinUrl?: string;
  seerrUrl?: string;
  seerrApiKey?: string;
}

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

  return {
    port,
    databasePath,
    jellyfinUrl,
    seerrUrl,
    seerrApiKey,
  };
}
