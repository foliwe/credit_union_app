export const APP_ROLES = ['admin', 'manager', 'agent', 'member'] as const

export type AppRole = (typeof APP_ROLES)[number]

export type LoginMode = 'email' | 'code'

export type EmailLoginInput = {
  role: 'admin' | 'manager'
  email: string
  password: string
}

export type CodeLoginInput = {
  role: 'agent' | 'member'
  code: string
  password: string
}

export type LoginInput = EmailLoginInput | CodeLoginInput

export type PasswordSignInPayload = {
  email: string
  password: string
}

export type SupabasePasswordAuthClient = {
  auth: {
    signInWithPassword(payload: PasswordSignInPayload): Promise<{
      data: unknown
      error: Error | null
    }>
  }
}

export type StorageAdapter = {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export type SessionSnapshot = {
  accessToken: string
  refreshToken: string
  userId: string
  role: AppRole
  branchId: string | null
  loginMode: LoginMode
  expiresAt: string
}