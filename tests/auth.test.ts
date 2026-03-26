import { afterEach, describe, expect, it, vi } from 'vitest'

const secureStoreMock = vi.hoisted(() => {
  const secureStoreState = new Map<string, string>()

  return {
    secureStoreState,
    getItemAsync: vi.fn(async (key: string) => secureStoreState.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      secureStoreState.set(key, value)
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      secureStoreState.delete(key)
    }),
  }
})

vi.mock('react-native', () => ({
  Platform: {
    OS: 'web',
  },
}))

vi.mock('react-native-url-polyfill/auto', () => ({}))

vi.mock('expo-secure-store', () => ({
  getItemAsync: secureStoreMock.getItemAsync,
  setItemAsync: secureStoreMock.setItemAsync,
  deleteItemAsync: secureStoreMock.deleteItemAsync,
}))

import { SecureStoreChunkedStorage } from '../lib/auth/secure-storage'
import {
  buildPasswordSignInPayload,
  isOfflineLoginAllowed,
  loginCodeToEmail,
  persistSessionSnapshot,
  readSessionSnapshot,
  signInWithCredentials,
} from '../lib/auth/session'
import {
  MOBILE_SUPABASE_CONFIG_ERROR_MESSAGE,
  createMobileSupabaseClient,
  getMobileSupabaseConfigState,
  resetMobileSupabaseClientForTests,
} from '../lib/auth/supabase'
import type { SessionSnapshot, StorageAdapter } from '../lib/auth/types'

class MemoryStorage implements StorageAdapter {
  private readonly state = new Map<string, string>()

  async getItem(key: string) {
    return this.state.get(key) ?? null
  }

  async setItem(key: string, value: string) {
    this.state.set(key, value)
  }

  async removeItem(key: string) {
    this.state.delete(key)
  }
}

const ORIGINAL_SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL
const ORIGINAL_SUPABASE_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY

function restoreSupabaseEnv() {
  if (typeof ORIGINAL_SUPABASE_URL === 'string') {
    process.env.EXPO_PUBLIC_SUPABASE_URL = ORIGINAL_SUPABASE_URL
  } else {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL
  }

  if (typeof ORIGINAL_SUPABASE_PUBLISHABLE_KEY === 'string') {
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ORIGINAL_SUPABASE_PUBLISHABLE_KEY
  } else {
    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  }
}

describe('mobile auth', () => {
  afterEach(() => {
    secureStoreMock.secureStoreState.clear()
    secureStoreMock.getItemAsync.mockClear()
    secureStoreMock.setItemAsync.mockClear()
    secureStoreMock.deleteItemAsync.mockClear()
    restoreSupabaseEnv()
    resetMobileSupabaseClientForTests()
  })

  it('uses Expo-safe SecureStore keys for chunk metadata and data', async () => {
    const storage = new SecureStoreChunkedStorage()
    const value = 'a'.repeat(4005)

    await storage.setItem('mf.auth.session', value)

    const writtenKeys = secureStoreMock.setItemAsync.mock.calls.map(([key]) => key)

    expect(writtenKeys).toEqual([
      'mf.auth.session_x3a_0',
      'mf.auth.session_x3a_1',
      'mf.auth.session_x3a_2',
      'mf.auth.session_x3a_count',
    ])
    expect(writtenKeys.every((key) => /^[A-Za-z0-9._-]+$/.test(key))).toBe(true)
  })

  it('reassembles chunked SecureStore values in order', async () => {
    const storage = new SecureStoreChunkedStorage()
    const value = 'abc'.repeat(1400)

    await storage.setItem('mf.auth.session', value)

    await expect(storage.getItem('mf.auth.session')).resolves.toBe(value)
  })

  it('deletes all chunked SecureStore entries using safe keys', async () => {
    const storage = new SecureStoreChunkedStorage()
    const value = 'z'.repeat(4005)

    await storage.setItem('mf.auth.session', value)
    await storage.removeItem('mf.auth.session')

    const deletedKeys = secureStoreMock.deleteItemAsync.mock.calls.map(([key]) => key)

    expect(deletedKeys).toEqual([
      'mf.auth.session_x3a_0',
      'mf.auth.session_x3a_1',
      'mf.auth.session_x3a_2',
      'mf.auth.session_x3a_count',
    ])
    expect(secureStoreMock.secureStoreState.size).toBe(0)
  })

  it('builds internal email aliases for field logins', () => {
    expect(loginCodeToEmail('AGENT01', 'agent')).toBe('agent01@agent.auth.local')
    expect(loginCodeToEmail('MEMBER01', 'member')).toBe('member01@member.auth.local')
  })

  it('reports missing mobile Supabase env without throwing at startup', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL
    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY

    expect(() => getMobileSupabaseConfigState()).not.toThrow()

    const state = getMobileSupabaseConfigState()

    expect(state).toMatchObject({
      status: 'missing-config',
      message: MOBILE_SUPABASE_CONFIG_ERROR_MESSAGE,
      missingKeys: ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'],
    })
  })

  it('returns configured mobile Supabase env when both public values are present', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://preview.supabase.co'
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test_key'

    expect(getMobileSupabaseConfigState()).toMatchObject({
      status: 'configured',
      url: 'https://preview.supabase.co',
      publishableKey: 'sb_publishable_test_key',
    })
  })

  it('returns a controlled configuration error when a client is requested without env', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL
    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY

    expect(() => createMobileSupabaseClient()).toThrowError(MOBILE_SUPABASE_CONFIG_ERROR_MESSAGE)
  })

  it('preserves email logins for privileged users', () => {
    expect(
      buildPasswordSignInPayload({
        role: 'admin',
        email: 'admin@example.com',
        password: 'secret-pass',
      })
    ).toEqual({ email: 'admin@example.com', password: 'secret-pass' })
  })

  it('persists and reloads session snapshots', async () => {
    const storage = new MemoryStorage()
    const snapshot: SessionSnapshot = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      userId: 'user-1',
      role: 'agent',
      branchId: 'branch-a',
      loginMode: 'code',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }

    await persistSessionSnapshot(storage, snapshot)

    await expect(readSessionSnapshot(storage)).resolves.toEqual(snapshot)
  })

  it('allows offline access for a non-expired cached field session', () => {
    const snapshot: SessionSnapshot = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      userId: 'user-1',
      role: 'agent',
      branchId: 'branch-a',
      loginMode: 'code',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }

    expect(isOfflineLoginAllowed(snapshot, new Date('2026-03-26T12:00:00.000Z'))).toBe(true)
  })

  it('blocks offline login when there is no cached session', () => {
    expect(isOfflineLoginAllowed(null, new Date('2026-03-26T12:00:00.000Z'))).toBe(false)
  })

  it('blocks offline login for expired sessions', () => {
    const snapshot: SessionSnapshot = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      userId: 'user-1',
      role: 'member',
      branchId: 'branch-a',
      loginMode: 'code',
      expiresAt: '2026-03-26T10:00:00.000Z',
    }

    expect(isOfflineLoginAllowed(snapshot, new Date('2026-03-26T12:00:00.000Z'))).toBe(false)
  })

  it('sends sign-in requests through Supabase password auth', async () => {
    const signInWithPassword = vi.fn().mockResolvedValue({ data: { session: { id: 'ok' } }, error: null })
    const client = { auth: { signInWithPassword } }

    const result = await signInWithCredentials(client, {
      role: 'agent',
      code: 'AGENT01',
      password: 'good-secret',
    })

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'agent01@agent.auth.local',
      password: 'good-secret',
    })
    expect(result.error).toBeNull()
  })
})