import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { PropsWithChildren } from 'react'

import type { Session, User } from '@supabase/supabase-js'

import {
  SESSION_STORAGE_KEY,
  isOfflineLoginAllowed,
  mobileSignInPreflightCheck,
  persistSessionSnapshot,
  readSessionSnapshot,
  signInWithCredentials,
} from '@/lib/auth/session'
import { SecureStoreChunkedStorage } from '@/lib/auth/secure-storage'
import { createMobileSupabaseClient, getMobileSupabaseConfigState } from '@/lib/auth/supabase'
import type { AppRole, LoginInput, LoginMode, SessionSnapshot } from '@/lib/auth/types'

type SessionContextValue = {
  isReady: boolean
  isOffline: boolean
  isRemoteAuthConfigured: boolean
  authConfigMessage: string | null
  session: Session | null
  snapshot: SessionSnapshot | null
  role: AppRole | null
  signIn(input: LoginInput): Promise<Error | null>
  signOut(): Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

function snapshotFromSession(session: Session, role: AppRole, branchId: string | null, loginMode: LoginMode): SessionSnapshot {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    userId: session.user.id,
    role,
    branchId,
    loginMode,
    expiresAt: new Date(session.expires_at ? session.expires_at * 1000 : Date.now() + 60 * 60 * 1000).toISOString(),
  }
}

function extractRole(user: User | null): AppRole | null {
  const rawRole = user?.app_metadata?.role
  if (rawRole === 'admin' || rawRole === 'manager' || rawRole === 'agent' || rawRole === 'member') {
    return rawRole
  }

  return null
}

function extractBranchId(user: User | null): string | null {
  const branchId = user?.app_metadata?.branch_id
  return typeof branchId === 'string' ? branchId : null
}

export function SessionProvider({ children }: PropsWithChildren) {
  const [isReady, setIsReady] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
  const authConfigState = useMemo(() => getMobileSupabaseConfigState(), [])

  useEffect(() => {
    const storage = new SecureStoreChunkedStorage()

    let isMounted = true
    let unsubscribe: (() => void) | null = null

    async function hydrate() {
      const cachedSnapshot = await readSessionSnapshot(storage)

      if (!isMounted) {
        return
      }

      setSnapshot(cachedSnapshot)

      if (authConfigState.status !== 'configured') {
        setSession(null)
        setIsReady(true)
        return
      }

      const supabase = createMobileSupabaseClient()
      const {
        data: { session: currentSession },
      } = await supabase.auth.getSession()

      if (!isMounted) {
        return
      }

      setSession(currentSession)
      setIsReady(true)

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
        if (!isMounted) {
          return
        }

        setSession(nextSession)

        if (!nextSession) {
          await storage.removeItem(SESSION_STORAGE_KEY)
          setSnapshot(null)
          return
        }

        const role = extractRole(nextSession.user)
        if (!role) {
          return
        }

        const nextSnapshot = snapshotFromSession(
          nextSession,
          role,
          extractBranchId(nextSession.user),
          role === 'agent' || role === 'member' ? 'code' : 'email'
        )

        await persistSessionSnapshot(storage, nextSnapshot)
        setSnapshot(nextSnapshot)
      })

      unsubscribe = () => subscription.unsubscribe()
    }

    hydrate()

    return () => {
      isMounted = false
      unsubscribe?.()
    }
  }, [authConfigState])

  const value = useMemo<SessionContextValue>(() => {
    const isOffline = !session && isOfflineLoginAllowed(snapshot, new Date())
    const role = extractRole(session?.user ?? null) ?? (isOffline ? snapshot?.role ?? null : null)

    return {
      isReady,
      isOffline,
      isRemoteAuthConfigured: authConfigState.status === 'configured',
      authConfigMessage: authConfigState.status === 'configured' ? null : authConfigState.message,
      session,
      snapshot,
      role,
      async signIn(input) {
        const preflightError = mobileSignInPreflightCheck(input)
        if (preflightError) {
          return preflightError
        }

        if (authConfigState.status !== 'configured') {
          return new Error(authConfigState.message)
        }

        const supabase = createMobileSupabaseClient()
        const result = await signInWithCredentials(supabase, input)

        if (result.error) {
          return result.error
        }

        return null
      },
      async signOut() {
        if (authConfigState.status !== 'configured') {
          const storage = new SecureStoreChunkedStorage()
          await storage.removeItem(SESSION_STORAGE_KEY)
          setSession(null)
          setSnapshot(null)
          return
        }

        const supabase = createMobileSupabaseClient()
        await supabase.auth.signOut()
      },
    }
  }, [authConfigState, isReady, session, snapshot])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession() {
  const context = useContext(SessionContext)
  if (!context) {
    throw new Error('useSession must be used within SessionProvider')
  }

  return context
}