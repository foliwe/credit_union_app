import { Redirect } from 'expo-router'

import { useSession } from '@/components/auth/session-provider'

export default function IndexScreen() {
  const { isReady, role } = useSession()

  if (!isReady) {
    return null
  }

  if (role === 'agent') {
    return <Redirect href="/agent" />
  }

  if (role === 'member') {
    return <Redirect href="/member" />
  }

  return <Redirect href="/login" />
}