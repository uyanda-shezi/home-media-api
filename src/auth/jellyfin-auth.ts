export interface JellyfinAuthData {
  userId: string;
  username: string;
  isAdministrator: boolean;
  accessToken: string;
}

export interface JellyfinAuthError {
  statusCode: 401 | 502;
  message: string;
}

export type JellyfinAuthResult =
  | { ok: true; data: JellyfinAuthData }
  | { ok: false; error: JellyfinAuthError };

export async function authenticateWithJellyfin(
  jellyfinUrl: string | undefined,
  username: string,
  pw: string
): Promise<JellyfinAuthResult> {
  if (!jellyfinUrl) {
    return {
      ok: false,
      error: {
        statusCode: 502,
        message: 'Identity provider (Jellyfin) unconfigured',
      },
    };
  }

  const endpoint = `${jellyfinUrl.replace(/\/+$/, '')}/Users/AuthenticateByName`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Emby-Authorization':
          'MediaBrowser Client="HomeMedia", Device="HomeMediaServer", DeviceId="home-media-api", Version="0.1.0"',
      },
      body: JSON.stringify({
        Username: username,
        Pw: pw,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 401 || res.status === 400) {
      return {
        ok: false,
        error: {
          statusCode: 401,
          message: 'Invalid username or password',
        },
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        error: {
          statusCode: 502,
          message: `Identity provider error: HTTP ${res.status}`,
        },
      };
    }

    const json = (await res.json()) as {
      User?: {
        Id?: string;
        Name?: string;
        Policy?: {
          IsAdministrator?: boolean;
        };
      };
      AccessToken?: string;
    };

    const userId = json.User?.Id;
    const resolvedUsername = json.User?.Name || username;
    const isAdministrator = Boolean(json.User?.Policy?.IsAdministrator);
    const accessToken = json.AccessToken;

    if (!userId || !accessToken) {
      return {
        ok: false,
        error: {
          statusCode: 502,
          message: 'Malformed response from Jellyfin identity provider',
        },
      };
    }

    return {
      ok: true,
      data: {
        userId,
        username: resolvedUsername,
        isAdministrator,
        accessToken,
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        statusCode: 502,
        message: 'Identity provider (Jellyfin) unreachable',
      },
    };
  }
}
