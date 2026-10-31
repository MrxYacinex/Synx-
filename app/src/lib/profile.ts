import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import type { PlatformId } from '../shared/protocol';
import { defaultServerUrl } from './config';

export interface Profile {
  clientId: string;
  name: string;
  serverUrl: string;
  platform: PlatformId;
  sound: boolean;
}

const KEY = 'synx.profile.v1';

function randomId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'c_';
  for (let i = 0; i < 20; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

let cache: Profile | null = null;
const listeners = new Set<(p: Profile) => void>();

export async function loadProfile(): Promise<Profile> {
  if (cache) return cache;
  let stored: Partial<Profile> = {};
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw);
  } catch {
    /* first run or storage unavailable */
  }
  cache = {
    clientId: stored.clientId || randomId(),
    name: stored.name || '',
    serverUrl: stored.serverUrl || defaultServerUrl(),
    platform: stored.platform || 'instagram',
    sound: stored.sound ?? true,
  };
  if (!stored.clientId) void AsyncStorage.setItem(KEY, JSON.stringify(cache));
  return cache;
}

export async function saveProfile(patch: Partial<Profile>): Promise<Profile> {
  const next = { ...(await loadProfile()), ...patch };
  cache = next;
  listeners.forEach((l) => l(next));
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

export function useProfile(): [Profile | null, (patch: Partial<Profile>) => Promise<Profile>] {
  const [profile, setProfile] = useState<Profile | null>(cache);
  useEffect(() => {
    let alive = true;
    void loadProfile().then((p) => alive && setProfile(p));
    listeners.add(setProfile);
    return () => {
      alive = false;
      listeners.delete(setProfile);
    };
  }, []);
  const update = useCallback((patch: Partial<Profile>) => saveProfile(patch), []);
  return [profile, update];
}
