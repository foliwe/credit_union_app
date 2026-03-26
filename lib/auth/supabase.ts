import 'react-native-url-polyfill/auto'

import { createClient } from '@supabase/supabase-js'
import { Platform } from 'react-native'
import { z } from 'zod'

import { SecureStoreChunkedStorage } from './secure-storage'

const envSchema = z.object({
  EXPO_PUBLIC_SUPABASE_URL: z.url(),
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
})

const MOBILE_SUPABASE_ENV_KEYS = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] as const

type MobileSupabaseEnvKey = (typeof MOBILE_SUPABASE_ENV_KEYS)[number]

type MobileSupabaseConfigState =
  | {
      status: 'configured'
      url: string
      publishableKey: string
    }
  | {
      status: 'missing-config'
      message: string
      missingKeys: MobileSupabaseEnvKey[]
    }
  | {
      status: 'invalid-config'
      message: string
    }

export const MOBILE_SUPABASE_CONFIG_ERROR_MESSAGE =
  'Supabase preview is not configured. Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY to app/mobile/.env.local, then restart Expo.'

const MOBILE_SUPABASE_INVALID_CONFIG_ERROR_MESSAGE =
  'Supabase preview configuration is invalid. Check EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in app/mobile/.env.local, then restart Expo.'

const webStorage = {
  getItem(key: string) {
    return Promise.resolve(globalThis.localStorage.getItem(key))
  },
  setItem(key: string, value: string) {
    globalThis.localStorage.setItem(key, value)
    return Promise.resolve()
  },
  removeItem(key: string) {
    globalThis.localStorage.removeItem(key)
    return Promise.resolve()
  },
}

let supabaseClient: ReturnType<typeof createClient> | null = null

export function getMobileSupabaseConfigState(): MobileSupabaseConfigState {
  const rawEnv = {
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  }

  const missingKeys = MOBILE_SUPABASE_ENV_KEYS.filter((key) => {
    const value = rawEnv[key]
    return typeof value !== 'string' || value.trim().length === 0
  })

  if (missingKeys.length > 0) {
    return {
      status: 'missing-config',
      message: MOBILE_SUPABASE_CONFIG_ERROR_MESSAGE,
      missingKeys,
    }
  }

  const parsedEnv = envSchema.safeParse(rawEnv)
  if (!parsedEnv.success) {
    return {
      status: 'invalid-config',
      message: MOBILE_SUPABASE_INVALID_CONFIG_ERROR_MESSAGE,
    }
  }

  return {
    status: 'configured',
    url: parsedEnv.data.EXPO_PUBLIC_SUPABASE_URL,
    publishableKey: parsedEnv.data.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  }
}

export function createMobileSupabaseClient() {
  if (supabaseClient) {
    return supabaseClient
  }

  const configState = getMobileSupabaseConfigState()
  if (configState.status !== 'configured') {
    throw new Error(configState.message)
  }

  supabaseClient = createClient(configState.url, configState.publishableKey, {
    auth: {
      storage: Platform.OS === 'web' ? webStorage : new SecureStoreChunkedStorage(),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  })

  return supabaseClient
}

export function resetMobileSupabaseClientForTests() {
  supabaseClient = null
}