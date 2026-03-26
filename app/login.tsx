import { useMemo, useState, useTransition } from 'react'
import { Redirect } from 'expo-router'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { useSession } from '@/components/auth/session-provider'
import type { AppRole } from '@/lib/auth/types'

type MobileLoginRole = Extract<AppRole, 'admin' | 'manager' | 'agent' | 'member'>

const LOGIN_ROLES: MobileLoginRole[] = ['agent', 'member', 'manager', 'admin']

export default function LoginScreen() {
  const { isReady, role, signIn, isRemoteAuthConfigured, authConfigMessage } = useSession()
  const [selectedRole, setSelectedRole] = useState<MobileLoginRole>('agent')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const usesCode = selectedRole === 'agent' || selectedRole === 'member'
  const isSignInDisabled = isPending || !isRemoteAuthConfigured

  const redirectHref = useMemo(() => {
    if (role === 'agent') {
      return '/agent'
    }

    if (role === 'member') {
      return '/member'
    }

    return null
  }, [role])

  if (!isReady) {
    return null
  }

  if (redirectHref) {
    return <Redirect href={redirectHref} />
  }

  return (
    <ThemedView style={styles.screen}>
      <View style={styles.card}>
        <ThemedText type="title">Secure Access</ThemedText>
        <ThemedText style={styles.supportingText}>
          Agents and members sign in with code plus password. Managers and admins use email.
        </ThemedText>

        {!isRemoteAuthConfigured ? (
          <View style={[styles.banner, styles.configBanner]}>
            <ThemedText style={styles.configBannerText}>{authConfigMessage}</ThemedText>
          </View>
        ) : null}

        <View style={styles.roleRow}>
          {LOGIN_ROLES.map((entry) => (
            <Pressable
              key={entry}
              onPress={() => setSelectedRole(entry)}
              style={[styles.roleChip, selectedRole === entry ? styles.roleChipActive : null]}>
              <ThemedText style={selectedRole === entry ? styles.roleChipActiveText : null}>
                {entry}
              </ThemedText>
            </Pressable>
          ))}
        </View>

        {usesCode ? (
          <TextInput
            autoCapitalize="characters"
            onChangeText={setCode}
            placeholder="Agent or member code"
            style={styles.input}
            value={code}
          />
        ) : (
          <TextInput
            autoCapitalize="none"
            keyboardType="email-address"
            onChangeText={setEmail}
            placeholder="Email address"
            style={styles.input}
            value={email}
          />
        )}

        <TextInput
          onChangeText={setPassword}
          placeholder="Password"
          secureTextEntry
          style={styles.input}
          value={password}
        />

        <View style={styles.banner}>
          <ThemedText style={styles.bannerText}>
            Offline access only resumes from an existing valid cached session on this device.
          </ThemedText>
        </View>

        {errorMessage ? <ThemedText style={styles.errorText}>{errorMessage}</ThemedText> : null}

        <Pressable
          disabled={isSignInDisabled}
          onPress={() => {
            setErrorMessage(null)
            startTransition(async () => {
              const error = await signIn(
                usesCode
                  ? { role: selectedRole as 'agent' | 'member', code, password }
                  : { role: selectedRole as 'admin' | 'manager', email, password }
              )

              if (error) {
                setErrorMessage(error.message)
              }
            })
          }}
          style={[styles.primaryButton, isSignInDisabled ? styles.primaryButtonDisabled : null]}>
          <ThemedText style={styles.primaryButtonText}>{isPending ? 'Signing in...' : 'Sign in'}</ThemedText>
        </Pressable>
      </View>
    </ThemedView>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    justifyContent: 'center',
    padding: 20,
    backgroundColor: '#f5f5ef',
  },
  card: {
    gap: 14,
    borderRadius: 24,
    backgroundColor: '#ffffff',
    padding: 20,
  },
  supportingText: {
    lineHeight: 20,
    opacity: 0.7,
  },
  roleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  roleChip: {
    borderRadius: 999,
    backgroundColor: '#ecf2ea',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  roleChipActive: {
    backgroundColor: '#0f766e',
  },
  roleChipActiveText: {
    color: '#ffffff',
  },
  input: {
    height: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#d4d4d4',
    paddingHorizontal: 14,
  },
  banner: {
    borderRadius: 16,
    backgroundColor: '#fff8db',
    padding: 12,
  },
  bannerText: {
    color: '#7c5b00',
  },
  configBanner: {
    backgroundColor: '#fbe4e6',
  },
  configBannerText: {
    color: '#8f1d2c',
  },
  errorText: {
    color: '#b91c1c',
  },
  primaryButton: {
    alignItems: 'center',
    borderRadius: 16,
    backgroundColor: '#0f766e',
    paddingVertical: 14,
  },
  primaryButtonDisabled: {
    opacity: 0.45,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '600',
  },
})