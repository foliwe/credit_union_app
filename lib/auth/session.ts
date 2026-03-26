import { z } from 'zod'

import type {
  CodeLoginInput,
  LoginInput,
  PasswordSignInPayload,
  SessionSnapshot,
  StorageAdapter,
  SupabasePasswordAuthClient,
} from './types'

export const SESSION_STORAGE_KEY = 'mf.auth.session'

const passwordSchema = z.string().min(8, 'Password must be at least 8 characters long')

const emailLoginSchema = z.object({
  role: z.enum(['admin', 'manager']),
  email: z.email(),
  password: passwordSchema,
})

const codeLoginSchema = z.object({
  role: z.enum(['agent', 'member']),
  code: z.string().trim().min(4).max(32).regex(/^[a-zA-Z0-9-]+$/),
  password: passwordSchema,
})

const sessionSnapshotSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(['admin', 'manager', 'agent', 'member']),
  branchId: z.string().nullable(),
  loginMode: z.enum(['email', 'code']),
  expiresAt: z.string().datetime(),
})

export function loginCodeToEmail(code: string, role: CodeLoginInput['role']): string {
  return `${code.trim().toLowerCase()}@${role}.auth.local`
}

export function buildPasswordSignInPayload(input: LoginInput): PasswordSignInPayload {
  if ('email' in input) {
    const parsed = emailLoginSchema.parse(input)

    return {
      email: parsed.email.trim().toLowerCase(),
      password: parsed.password,
    }
  }

  const parsed = codeLoginSchema.parse(input)

  return {
    email: loginCodeToEmail(parsed.code, parsed.role),
    password: parsed.password,
  }
}

export async function signInWithCredentials(client: SupabasePasswordAuthClient, input: LoginInput) {
  return client.auth.signInWithPassword(buildPasswordSignInPayload(input))
}

export async function persistSessionSnapshot(storage: StorageAdapter, snapshot: SessionSnapshot) {
  const parsed = sessionSnapshotSchema.parse(snapshot)
  await storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(parsed))
}

export async function readSessionSnapshot(storage: StorageAdapter): Promise<SessionSnapshot | null> {
  const rawValue = await storage.getItem(SESSION_STORAGE_KEY)
  if (!rawValue) {
    return null
  }

  const parsed = JSON.parse(rawValue) as unknown
  return sessionSnapshotSchema.parse(parsed)
}

export function isOfflineLoginAllowed(snapshot: SessionSnapshot | null, now: Date): boolean {
  if (!snapshot) {
    return false
  }

  return new Date(snapshot.expiresAt).getTime() > now.getTime()
}

/**
 * Returns an error if the given login input is for a role that is not permitted
 * on the mobile app. Managers and admins use the admin app exclusively.
 */
export function mobileSignInPreflightCheck(input: LoginInput): Error | null {
  if (input.role === 'admin' || input.role === 'manager') {
    return new Error('Managers and admins must use the admin app to sign in.')
  }
  return null
}