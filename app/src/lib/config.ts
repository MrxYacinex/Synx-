import Constants from 'expo-constants';

/**
 * Where the Synx sync server lives.
 *  1. EXPO_PUBLIC_SYNX_SERVER (set this to your deployed wss:// URL for real builds)
 *  2. app.json -> expo.extra.serverUrl
 *  3. In development: the computer running `expo start`, port 8787
 */
export function defaultServerUrl(): string {
  const env = process.env.EXPO_PUBLIC_SYNX_SERVER;
  if (env) return env;
  const extra = (Constants.expoConfig?.extra as { serverUrl?: string } | undefined)?.serverUrl;
  if (extra) return extra;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  if (host) return `ws://${host}:8787`;
  return 'ws://localhost:8787';
}

/** ws(s)://host -> http(s)://host, for share links and health checks. */
export function httpBase(serverUrl: string): string {
  return serverUrl.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');
}

export function shareLink(serverUrl: string, code: string): string {
  return `${httpBase(serverUrl)}/join/${code}`;
}
