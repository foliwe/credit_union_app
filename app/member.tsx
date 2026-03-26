import { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'

import { useSession } from '@/components/auth/session-provider'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { openInitializedDatabase, type DatabaseConnection } from '@/lib/db/database'
import { getCurrentLoanScheduleSnapshot, listCachedLoans } from '@/lib/db/repositories/loans'
import { formatMinorCurrency, type MobileLoanPreview } from '@/lib/loans/mobile-loans'

async function loadLoanPreviews(database: DatabaseConnection): Promise<MobileLoanPreview[]> {
  const cachedLoans = await listCachedLoans(database)

  return Promise.all(
    cachedLoans.map(async (loan) => {
      const snapshot = await getCurrentLoanScheduleSnapshot(database, loan.clientLoanId)

      return {
        loanId: loan.clientLoanId,
        memberId: loan.memberId,
        memberLabel: loan.memberId,
        productName: loan.productName,
        currencyCode: loan.currencyCode,
        principalMinor: loan.principalMinor,
        outstandingPrincipalMinor: loan.outstandingPrincipalMinor,
        accruedInterestMinor: loan.accruedInterestMinor,
        totalRepaidMinor: loan.totalRepaidMinor,
        status: loan.status as MobileLoanPreview['status'],
        syncState: loan.syncState,
        queueOperationId: loan.sourceQueueOperationId,
        firstDueDate: snapshot?.effectiveFrom ?? 'Pending',
        lastReconciledAt: loan.lastReconciledAt,
        staleAt: loan.staleAt,
        conflictReason:
          loan.syncState === 'conflict' ? 'Server authority adjusted this loan during reconciliation.' : null,
        installments: snapshot?.schedule ?? [],
      }
    })
  )
}

function bannerStyle(syncState: MobileLoanPreview['syncState']) {
  if (syncState === 'authoritative') {
    return styles.bannerOnline
  }

  if (syncState === 'conflict') {
    return styles.bannerConflict
  }

  if (syncState === 'stale') {
    return styles.bannerOffline
  }

  return styles.bannerProvisional
}

function bannerCopy(syncState: MobileLoanPreview['syncState']) {
  if (syncState === 'authoritative') {
    return 'Server-authoritative loan data'
  }

  if (syncState === 'conflict') {
    return 'Conflict pending review'
  }

  if (syncState === 'stale') {
    return 'Cached data may be stale'
  }

  return 'Provisional local loan capture'
}

export default function MemberHomeScreen() {
  const { isOffline, signOut } = useSession()
  const [loans, setLoans] = useState<MobileLoanPreview[]>([])
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    async function hydrate() {
      const database = await openInitializedDatabase()
      const nextLoans = await loadLoanPreviews(database)

      if (isMounted) {
        setLoans(nextLoans)
      }
    }

    hydrate().catch((error) => {
      if (isMounted) {
        setMessage(error instanceof Error ? error.message : 'Unable to load cached member loans.')
      }
    })

    return () => {
      isMounted = false
    }
  }, [])

  return (
    <ThemedView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <ThemedText type="title">Member loan dashboard</ThemedText>
          <ThemedText>
            Members can now see local loan projections, repayment outcomes, and whether each card is provisional, stale, conflicted, or server-confirmed.
          </ThemedText>
          <View style={[styles.banner, isOffline ? styles.bannerOffline : styles.bannerOnline]}>
            <ThemedText>{isOffline ? 'Offline: cached loan portfolio in view' : 'Online: loan portfolio ready to reconcile'}</ThemedText>
          </View>
          {message ? <ThemedText>{message}</ThemedText> : null}
        </View>

        <View style={styles.summaryRow}>
          <View style={styles.summaryTile}>
            <ThemedText type="defaultSemiBold">Visible loans</ThemedText>
            <ThemedText type="title">{loans.length}</ThemedText>
          </View>
          <View style={styles.summaryTile}>
            <ThemedText type="defaultSemiBold">Needs attention</ThemedText>
            <ThemedText type="title">{loans.filter((loan) => loan.syncState !== 'authoritative').length}</ThemedText>
          </View>
        </View>

        {loans.length === 0 ? (
          <View style={styles.card}>
            <ThemedText>No cached loans are available on this device yet.</ThemedText>
            <ThemedText>Once the agent syncs or captures a provisional loan, the member-facing cache will surface it here with the appropriate state badge.</ThemedText>
          </View>
        ) : null}

        {loans.map((loan) => (
          <View key={`${loan.loanId}_${loan.syncState}`} style={styles.card}>
            <View style={styles.loanHeader}>
              <View>
                <ThemedText type="subtitle">{loan.productName}</ThemedText>
                <ThemedText>{loan.memberLabel}</ThemedText>
              </View>
              <View style={[styles.banner, bannerStyle(loan.syncState)]}>
                <ThemedText style={styles.bannerText}>{bannerCopy(loan.syncState)}</ThemedText>
              </View>
            </View>

            <ThemedText>Outstanding principal: {formatMinorCurrency(loan.outstandingPrincipalMinor, loan.currencyCode)}</ThemedText>
            <ThemedText>Accrued interest: {formatMinorCurrency(loan.accruedInterestMinor, loan.currencyCode)}</ThemedText>
            <ThemedText>Total repaid: {formatMinorCurrency(loan.totalRepaidMinor, loan.currencyCode)}</ThemedText>
            <ThemedText>First due date: {loan.firstDueDate}</ThemedText>
            {loan.staleAt ? <ThemedText>Last synced: {loan.staleAt}</ThemedText> : null}
            {loan.conflictReason ? <ThemedText>{loan.conflictReason}</ThemedText> : null}

            <View style={styles.installmentList}>
              <ThemedText type="defaultSemiBold">Current schedule snapshot</ThemedText>
              {loan.installments.slice(0, 3).map((installment) => (
                <View key={`${loan.loanId}_${installment.installmentNumber}`} style={styles.installmentRow}>
                  <ThemedText>#{installment.installmentNumber} due {installment.dueDate}</ThemedText>
                  <ThemedText>
                    {formatMinorCurrency(
                      installment.outstandingInterestMinor + installment.outstandingPrincipalMinor,
                      loan.currencyCode
                    )}
                  </ThemedText>
                </View>
              ))}
            </View>
          </View>
        ))}

        <Pressable onPress={() => signOut()} style={styles.button}>
          <ThemedText style={styles.buttonText}>Sign out</ThemedText>
        </Pressable>
      </ScrollView>
    </ThemedView>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f5f5ef',
  },
  content: {
    gap: 16,
    padding: 20,
  },
  card: {
    gap: 14,
    borderRadius: 24,
    backgroundColor: '#ffffff',
    padding: 20,
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 12,
  },
  summaryTile: {
    flex: 1,
    gap: 8,
    borderRadius: 20,
    backgroundColor: '#fff7ed',
    padding: 18,
  },
  loanHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  banner: {
    alignSelf: 'flex-start',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  bannerOnline: {
    backgroundColor: '#dcfce7',
  },
  bannerOffline: {
    backgroundColor: '#fef3c7',
  },
  bannerProvisional: {
    backgroundColor: '#dbeafe',
  },
  bannerConflict: {
    backgroundColor: '#fee2e2',
  },
  bannerText: {
    fontWeight: '600',
  },
  installmentList: {
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 12,
  },
  installmentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  button: {
    alignItems: 'center',
    borderRadius: 16,
    backgroundColor: '#111827',
    paddingVertical: 14,
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '600',
  },
})