import { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'

import { useSession } from '@/components/auth/session-provider'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { openInitializedDatabase, type DatabaseConnection } from '@/lib/db/database'
import {
  createProvisionalLoanWithQueue,
  getCurrentLoanScheduleSnapshot,
  listCachedLoans,
} from '@/lib/db/repositories/loans'
import {
  createLoanRepaymentWithQueue,
  createLocalTransactionWithQueue,
  listLocalTransactions,
} from '@/lib/db/repositories/transactions'
import {
  getLocalCashSessionDashboard,
  openLocalCashSession,
  queueLocalCashReconciliationSubmission,
  saveLocalCashReconciliationDraft,
} from '@/lib/db/repositories/agent-cash'
import {
  formatMinorCurrency,
  type MobileLoanPreview,
} from '@/lib/loans/mobile-loans'
import { runLoanSync } from '@/lib/loans/sync'
import { runTransactionSync } from '@/lib/transactions/sync'
import type { LocalAgentCashDashboard, LocalTransactionRecord, TransactionType } from '@/lib/types/offline'

type LoanCreateFormState = {
  memberId: string
  memberLabel: string
  productCode: string
  productName: string
  principalMinor: string
  termMonths: string
  monthlyInterestRateBps: string
  repaymentDayOfMonth: string
}

type LoanRepaymentFormState = {
  loanId: string
  amountMinor: string
}

type TransactionFormState = {
  memberId: string
  accountId: string
  transactionType: Extract<TransactionType, 'deposit' | 'withdrawal'>
  amountMinor: string
  availableBalanceMinor: string
  note: string
  identityConfirmed: boolean
  cashConfirmed: boolean
}

type CashSessionFormState = {
  businessDate: string
  businessTimezone: string
  openingFloatMinor: string
  maxSessionCarryMinor: string
  minimumReserveMinor: string
}

type ReconciliationFormState = {
  declaredCashMinor: string
  notes: string
}

const defaultLoanCreateForm: LoanCreateFormState = {
  memberId: 'member-401',
  memberLabel: 'Grace W.',
  productCode: 'SME-06',
  productName: 'SME Growth',
  principalMinor: '120000',
  termMonths: '6',
  monthlyInterestRateBps: '250',
  repaymentDayOfMonth: '5',
}

const defaultRepaymentForm: LoanRepaymentFormState = { loanId: '', amountMinor: '9000' }

const defaultTransactionForm: TransactionFormState = {
  memberId: 'member-401',
  accountId: 'savings-401',
  transactionType: 'deposit',
  amountMinor: '4500',
  availableBalanceMinor: '60000',
  note: '',
  identityConfirmed: false,
  cashConfirmed: false,
}

function currentBusinessDate() {
  return new Date().toISOString().slice(0, 10)
}

function createDefaultCashSessionForm(): CashSessionFormState {
  return {
    businessDate: currentBusinessDate(),
    businessTimezone: 'Africa/Nairobi',
    openingFloatMinor: '25000',
    maxSessionCarryMinor: '80000',
    minimumReserveMinor: '5000',
  }
}

const defaultReconciliationForm: ReconciliationFormState = {
  declaredCashMinor: '',
  notes: '',
}

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

function parsePositiveInteger(value: string, fieldName: string) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive whole number in minor units`)
  }

  return parsed
}

function parseNonNegativeInteger(value: string, fieldName: string) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a whole number in minor units`) 
  }

  return parsed
}

function parseOptionalInteger(value: string) {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  return parseNonNegativeInteger(trimmed, 'Carry limit')
}

function statusAccent(syncState: MobileLoanPreview['syncState']) {
  if (syncState === 'authoritative') {
    return styles.stateAuthoritative
  }

  if (syncState === 'conflict') {
    return styles.stateConflict
  }

  if (syncState === 'stale') {
    return styles.stateStale
  }

  return styles.stateProvisional
}

function statusCopy(syncState: MobileLoanPreview['syncState']) {
  if (syncState === 'authoritative') {
    return 'Server-confirmed'
  }

  if (syncState === 'conflict') {
    return 'Conflict: server changed the loan'
  }

  if (syncState === 'stale') {
    return 'Stale cache: refresh when online'
  }

  return 'Provisional: waiting for sync and review'
}

function cashLimitAccent(limitStatus: NonNullable<LocalAgentCashDashboard>['summary']['limitStatus']) {
  if (limitStatus === 'negative_cash' || limitStatus === 'carry_limit_breached') {
    return styles.stateConflict
  }

  if (limitStatus === 'reserve_low') {
    return styles.stateStale
  }

  return styles.stateAuthoritative
}

function cashLimitCopy(limitStatus: NonNullable<LocalAgentCashDashboard>['summary']['limitStatus']) {
  if (limitStatus === 'negative_cash') {
    return 'Projected negative cash'
  }

  if (limitStatus === 'carry_limit_breached') {
    return 'Carry limit breached locally'
  }

  if (limitStatus === 'reserve_low') {
    return 'Reserve buffer low'
  }

  return 'Within local limits'
}

export default function AgentHomeScreen() {
  const { isOffline, snapshot, signOut } = useSession()
  const [database, setDatabase] = useState<DatabaseConnection | null>(null)
  const [loanForm, setLoanForm] = useState(defaultLoanCreateForm)
  const [repaymentForm, setRepaymentForm] = useState(defaultRepaymentForm)
  const [transactionForm, setTransactionForm] = useState(defaultTransactionForm)
  const [cashSessionForm, setCashSessionForm] = useState(createDefaultCashSessionForm)
  const [reconciliationForm, setReconciliationForm] = useState(defaultReconciliationForm)
  const [loans, setLoans] = useState<MobileLoanPreview[]>([])
  const [transactions, setTransactions] = useState<LocalTransactionRecord[]>([])
  const [cashDashboard, setCashDashboard] = useState<LocalAgentCashDashboard | null>(null)
  const [isSyncingLoans, setIsSyncingLoans] = useState(false)
  const [isSyncingCash, setIsSyncingCash] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function refreshLocalState(nextDatabase: DatabaseConnection) {
    setLoans(await loadLoanPreviews(nextDatabase))
    setTransactions(await listLocalTransactions(nextDatabase))
    setCashDashboard(
      await getLocalCashSessionDashboard(nextDatabase, {
        actorId: snapshot?.userId ?? 'offline-agent',
        branchId: snapshot?.branchId ?? 'branch-demo',
        businessDate: cashSessionForm.businessDate.trim() || currentBusinessDate(),
      })
    )
  }

  useEffect(() => {
    let isMounted = true

    async function hydrate() {
      const nextDatabase = await openInitializedDatabase()
      if (!isMounted) {
        return
      }

      setDatabase(nextDatabase)
      await refreshLocalState(nextDatabase)
    }

    hydrate().catch((error) => {
      if (isMounted) {
        setMessage(error instanceof Error ? error.message : 'Unable to open the local loan database.')
      }
    })

    return () => {
      isMounted = false
    }
  }, [])

  function handleCreateLoan() {
    if (!database) {
      setMessage('Local database is still loading. Try again in a moment.')
      return
    }

    try {
      const submittedAt = new Date().toISOString()

      createProvisionalLoanWithQueue(database, {
        memberId: loanForm.memberId.trim(),
        actorId: snapshot?.userId ?? 'offline-agent',
        branchId: snapshot?.branchId ?? 'branch-demo',
        deviceInstallationId: `device-${snapshot?.userId ?? 'offline-agent'}`,
        submittedAt,
        product: {
          branchId: snapshot?.branchId ?? 'branch-demo',
          productCode: loanForm.productCode.trim(),
          productName: loanForm.productName.trim(),
          currencyCode: 'KES',
          principalMinor: parsePositiveInteger(loanForm.principalMinor, 'Principal'),
          termMonths: parsePositiveInteger(loanForm.termMonths, 'Term months'),
          monthlyInterestRateBps: parsePositiveInteger(loanForm.monthlyInterestRateBps, 'Monthly interest rate (bps)'),
          repaymentDayOfMonth: parsePositiveInteger(loanForm.repaymentDayOfMonth, 'Repayment day of month'),
          interestStrategy: 'monthly_remaining_principal',
          repaymentAllocationStrategy: 'interest_then_principal',
        },
        queue: {
          operationId: `loan.create.${Date.now()}`,
          lastKnownServerVersion: null,
        },
        metadata: {
          memberLabel: loanForm.memberLabel.trim() || loanForm.memberId.trim(),
        },
      })
        .then(async (created) => {
          await refreshLocalState(database)
          setRepaymentForm({ loanId: created.loan.clientLoanId, amountMinor: '9000' })
          setMessage(`Queued ${created.loan.productName} for ${loanForm.memberLabel || loanForm.memberId}. It is visible as provisional until the server responds.`)
          setLoanForm(defaultLoanCreateForm)
        })
        .catch((error) => {
          setMessage(error instanceof Error ? error.message : 'Unable to queue loan creation right now.')
        })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to queue loan creation right now.')
    }
  }

  function handleCaptureRepayment() {
    if (!database) {
      setMessage('Local database is still loading. Try again in a moment.')
      return
    }

    try {
      const amountMinor = parsePositiveInteger(repaymentForm.amountMinor, 'Repayment amount')
      const selectedLoan = loans.find((loan) => loan.loanId === repaymentForm.loanId)

      if (!selectedLoan) {
        throw new Error('Pick a visible loan before capturing a repayment.')
      }

      const timestamp = new Date().toISOString()

      createLoanRepaymentWithQueue(database, {
        loanId: selectedLoan.loanId,
        memberId: selectedLoan.memberId,
        accountId: `loan-account:${selectedLoan.loanId}`,
        amountMinor,
        currencyCode: selectedLoan.currencyCode,
        effectiveAt: timestamp,
        capturedAt: timestamp,
        actorId: snapshot?.userId ?? 'offline-agent',
        branchId: snapshot?.branchId ?? 'branch-demo',
        deviceInstallationId: `device-${snapshot?.userId ?? 'offline-agent'}`,
        queueOperationId: `loan.repayment.${Date.now()}`,
        lastKnownServerVersion: null,
        installments: selectedLoan.installments,
      })
        .then(async () => {
          await refreshLocalState(database)
          setMessage(
            `Queued ${formatMinorCurrency(amountMinor, selectedLoan.currencyCode)} against ${selectedLoan.productName}. The repayment preview is provisional until the server applies it.`
          )
          setRepaymentForm((current) => ({ ...current, amountMinor: '9000' }))
        })
        .catch((error) => {
          setMessage(error instanceof Error ? error.message : 'Unable to queue this repayment right now.')
        })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to queue this repayment right now.')
    }
  }

  function handleSyncLoans() {
    if (!database) {
      setMessage('Local database is still loading. Try again in a moment.')
      return
    }

    if (isOffline) {
      setMessage('Loan sync requires an active connection and Supabase session.')
      return
    }

    setIsSyncingLoans(true)
    runLoanSync(database)
      .then(async (summary) => {
        await refreshLocalState(database)
        setMessage(
          `Loan sync processed ${summary.processed} queue entries. Synced ${summary.synced}, conflicts ${summary.conflicts}, failed ${summary.failed}, replayed ${summary.replayed}.`
        )
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : 'Unable to run loan sync right now.')
      })
      .finally(() => {
        setIsSyncingLoans(false)
      })
  }

  function handleQueueTransaction() {
    if (!database) {
      setMessage('Local database is still loading. Try again in a moment.')
      return
    }

    try {
      const amountMinor = parsePositiveInteger(transactionForm.amountMinor, 'Transaction amount')
      const capturedAt = new Date().toISOString()

      createLocalTransactionWithQueue(database, {
        transaction: {
          clientTransactionId: `txn.${Date.now()}`,
          memberId: transactionForm.memberId.trim(),
          accountId: transactionForm.accountId.trim(),
          transactionType: transactionForm.transactionType,
          amountMinor,
          currencyCode: 'KES',
          occurredAt: capturedAt,
          capturedAt,
          payload: {
            note: transactionForm.note.trim() || null,
          },
          actorId: snapshot?.userId ?? 'offline-agent',
          branchId: snapshot?.branchId ?? 'branch-demo',
          deviceInstallationId: `device-${snapshot?.userId ?? 'offline-agent'}`,
          captureContext: {
            isOfflineCapture: isOffline,
            availableBalanceMinor: transactionForm.availableBalanceMinor.trim().length > 0
              ? parsePositiveInteger(transactionForm.availableBalanceMinor, 'Available balance')
              : null,
            identityConfirmed: transactionForm.transactionType === 'withdrawal' ? transactionForm.identityConfirmed : true,
            cashConfirmed: transactionForm.transactionType === 'withdrawal' ? transactionForm.cashConfirmed : true,
          },
        },
        queue: {
          operationId: `transaction.create.${Date.now()}`,
          operationType: 'transaction.create',
          lastKnownServerVersion: snapshot?.accessToken ?? null,
        },
      })
        .then(async (created) => {
          await refreshLocalState(database)
          const hintSummary = created.transaction.fraudHints.map((hint) => hint.code).join(', ')
          setMessage(
            created.transaction.guardrailStatus === 'review'
              ? `Queued locally with review flags. ${formatMinorCurrency(created.transaction.amountMinor, created.transaction.currencyCode)} still needs sync and manager review. ${hintSummary ? `Hints: ${hintSummary}.` : ''}`
              : `Queued locally only. ${formatMinorCurrency(created.transaction.amountMinor, created.transaction.currencyCode)} is not authoritative until sync completes.${hintSummary ? ` Hints: ${hintSummary}.` : ''}`
          )
          setTransactionForm((current) => ({
            ...defaultTransactionForm,
            memberId: current.memberId,
            accountId: current.accountId,
            transactionType: current.transactionType,
            availableBalanceMinor: current.availableBalanceMinor,
          }))
        })
        .catch((error) => {
          setMessage(error instanceof Error ? error.message : 'Unable to queue this transaction right now.')
        })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to queue this transaction right now.')
    }
  }

  function handleSyncCash() {
    if (!database) {
      setMessage('Local database is still loading. Try again in a moment.')
      return
    }

    if (isOffline) {
      setMessage('Cash sync requires an active connection and Supabase session.')
      return
    }

    setIsSyncingCash(true)
    runTransactionSync(database)
      .then(async (summary) => {
        await refreshLocalState(database)
        setMessage(
          `Cash sync processed ${summary.processed} queue entries. Synced ${summary.synced}, conflicts ${summary.conflicts}, failed ${summary.failed}, replayed ${summary.replayed}.`
        )
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : 'Unable to run cash sync right now.')
      })
      .finally(() => {
        setIsSyncingCash(false)
      })
  }

  function handleOpenCashSession() {
    if (!database) {
      setMessage('Local database is still loading. Try again in a moment.')
      return
    }

    try {
      const openedAt = new Date().toISOString()

      openLocalCashSession(database, {
        actorId: snapshot?.userId ?? 'offline-agent',
        branchId: snapshot?.branchId ?? 'branch-demo',
        deviceInstallationId: `device-${snapshot?.userId ?? 'offline-agent'}`,
        businessDate: cashSessionForm.businessDate.trim() || currentBusinessDate(),
        businessTimezone: cashSessionForm.businessTimezone.trim() || 'Africa/Nairobi',
        openingFloatMinor: parseNonNegativeInteger(cashSessionForm.openingFloatMinor, 'Opening float'),
        maxSessionCarryMinor: parseOptionalInteger(cashSessionForm.maxSessionCarryMinor),
        minimumReserveMinor: parseNonNegativeInteger(cashSessionForm.minimumReserveMinor, 'Minimum reserve'),
        openedAt,
        lastKnownServerVersion: snapshot?.accessToken ?? null,
      })
        .then(async (session) => {
          await refreshLocalState(database)
          setReconciliationForm({
            declaredCashMinor: String(session.openingFloatMinor),
            notes: '',
          })
          setMessage(
            `Opened a local cash session for ${session.businessDate}. Opening float and limits are cached locally and remain provisional until the server confirms them.`
          )
        })
        .catch((error) => {
          setMessage(error instanceof Error ? error.message : 'Unable to open the local cash session right now.')
        })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to open the local cash session right now.')
    }
  }

  function handleSaveReconciliationDraft() {
    if (!database) {
      setMessage('Local database is still loading. Try again in a moment.')
      return
    }

    if (!cashDashboard) {
      setMessage('Open or resume a local cash session before saving a reconciliation draft.')
      return
    }

    try {
      const savedAt = new Date().toISOString()

      saveLocalCashReconciliationDraft(database, {
        sessionId: cashDashboard.session.id,
        declaredCashMinor: parseNonNegativeInteger(reconciliationForm.declaredCashMinor, 'Declared cash'),
        notes: reconciliationForm.notes,
        counts: {},
        lastKnownServerVersion: cashDashboard.session.lastKnownServerVersion,
        savedAt,
      })
        .then(async (draft) => {
          await refreshLocalState(database)
          setMessage(
            `Saved the local reconciliation draft. Declared cash is stored on-device and remains provisional until sync sends it to the authoritative agent-cash service.`
          )
          setReconciliationForm((current) => ({
            ...current,
            declaredCashMinor: String(draft.declaredCashMinor),
          }))
        })
        .catch((error) => {
          setMessage(error instanceof Error ? error.message : 'Unable to save the reconciliation draft right now.')
        })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to save the reconciliation draft right now.')
    }
  }

  function handleQueueReconciliationIntent() {
    if (!database) {
      setMessage('Local database is still loading. Try again in a moment.')
      return
    }

    if (!cashDashboard) {
      setMessage('Open or resume a local cash session before queueing reconciliation.')
      return
    }

    try {
      const queuedAt = new Date().toISOString()

      queueLocalCashReconciliationSubmission(database, {
        sessionId: cashDashboard.session.id,
        declaredCashMinor: parseNonNegativeInteger(reconciliationForm.declaredCashMinor, 'Declared cash'),
        notes: reconciliationForm.notes,
        counts: {},
        actorId: snapshot?.userId ?? 'offline-agent',
        branchId: snapshot?.branchId ?? 'branch-demo',
        deviceInstallationId: `device-${snapshot?.userId ?? 'offline-agent'}`,
        operationId: `agent.cash.reconcile.submit.${Date.now()}`,
        lastKnownServerVersion: cashDashboard.session.lastKnownServerVersion,
        queuedAt,
      })
        .then(async () => {
          await refreshLocalState(database)
          setMessage(
            'Queued a local reconciliation intent. This remains provisional until cash sync submits it to the authoritative agent-cash service.'
          )
        })
        .catch((error) => {
          setMessage(error instanceof Error ? error.message : 'Unable to queue reconciliation right now.')
        })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to queue reconciliation right now.')
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <ThemedText type="title">Agent cash and loan workspace</ThemedText>
          <ThemedText>
            Capture cash, loan requests, and repayments locally. Every number below is provisional until the server confirms it, and local cash totals never override the authoritative branch view.
          </ThemedText>

          <View style={[styles.statusPill, isOffline ? styles.statusPillOffline : styles.statusPillOnline]}>
            <ThemedText style={styles.statusText}>{isOffline ? 'Offline: queueing cash and loan work locally' : 'Online: local cash and loan queues are ready for sync'}</ThemedText>
          </View>

          <ThemedText>Branch: {snapshot?.branchId ?? 'Unassigned'}</ThemedText>
          <Pressable
            onPress={handleSyncLoans}
            disabled={!database || isOffline || isSyncingLoans}
            style={[
              styles.primaryButton,
              (!database || isOffline || isSyncingLoans) ? styles.primaryButtonDisabled : null,
            ]}>
            <ThemedText style={styles.primaryButtonText}>
              {isSyncingLoans ? 'Syncing queued loan work...' : 'Sync queued loan work'}
            </ThemedText>
          </Pressable>
          {message ? (
            <View style={styles.noticeCard}>
              <ThemedText style={styles.noticeText}>{message}</ThemedText>
            </View>
          ) : null}
        </View>

        <View style={styles.card}>
          <ThemedText type="subtitle">Local Cash Session</ThemedText>
          <ThemedText style={styles.sectionHint}>
            Open a local business day before capturing cash. The totals below stay provisional until the authoritative agent-cash service confirms them during sync.
          </ThemedText>

          <Pressable
            onPress={handleSyncCash}
            disabled={!database || isOffline || isSyncingCash}
            style={[
              styles.primaryButton,
              (!database || isOffline || isSyncingCash) ? styles.primaryButtonDisabled : null,
            ]}>
            <ThemedText style={styles.primaryButtonText}>
              {isSyncingCash ? 'Syncing queued cash work...' : 'Sync queued cash work'}
            </ThemedText>
          </Pressable>

          <TextInput
            placeholder="Business date"
            value={cashSessionForm.businessDate}
            onChangeText={(value) => setCashSessionForm((current) => ({ ...current, businessDate: value }))}
            style={styles.input}
          />
          <TextInput
            placeholder="Business timezone"
            value={cashSessionForm.businessTimezone}
            onChangeText={(value) => setCashSessionForm((current) => ({ ...current, businessTimezone: value }))}
            style={styles.input}
          />
          <View style={styles.row}>
            <TextInput
              placeholder="Opening float minor"
              value={cashSessionForm.openingFloatMinor}
              keyboardType="number-pad"
              onChangeText={(value) => setCashSessionForm((current) => ({ ...current, openingFloatMinor: value }))}
              style={[styles.input, styles.rowInput]}
            />
            <TextInput
              placeholder="Carry limit minor"
              value={cashSessionForm.maxSessionCarryMinor}
              keyboardType="number-pad"
              onChangeText={(value) => setCashSessionForm((current) => ({ ...current, maxSessionCarryMinor: value }))}
              style={[styles.input, styles.rowInput]}
            />
          </View>
          <TextInput
            placeholder="Minimum reserve minor"
            value={cashSessionForm.minimumReserveMinor}
            keyboardType="number-pad"
            onChangeText={(value) => setCashSessionForm((current) => ({ ...current, minimumReserveMinor: value }))}
            style={styles.input}
          />

          <Pressable onPress={handleOpenCashSession} style={styles.primaryButton}>
            <ThemedText style={styles.primaryButtonText}>Open local cash day</ThemedText>
          </Pressable>

          {cashDashboard ? (
            <>
              <View style={[styles.stateBadge, cashLimitAccent(cashDashboard.summary.limitStatus)]}>
                <ThemedText style={styles.stateBadgeText}>{cashLimitCopy(cashDashboard.summary.limitStatus)}</ThemedText>
              </View>

              <View style={styles.metricCard}>
                <ThemedText type="defaultSemiBold">Provisional local totals</ThemedText>
                <ThemedText>Business day: {cashDashboard.session.businessDate}</ThemedText>
                <ThemedText>Opening float: {formatMinorCurrency(cashDashboard.summary.openingFloatMinor, 'KES')}</ThemedText>
                <ThemedText>Daily collections: {formatMinorCurrency(cashDashboard.summary.dailyCollectionsMinor, 'KES')}</ThemedText>
                <ThemedText>Daily withdrawals: {formatMinorCurrency(cashDashboard.summary.dailyWithdrawalsMinor, 'KES')}</ThemedText>
                <ThemedText>Projected cash-on-hand: {formatMinorCurrency(cashDashboard.summary.projectedCashOnHandMinor, 'KES')}</ThemedText>
                <ThemedText>Limit status: {cashDashboard.summary.limitMessage}</ThemedText>
                <ThemedText>
                  Reconciliation: {cashDashboard.summary.reconciliationRequired ? 'Required before local day closeout' : 'No local cash activity yet'}
                </ThemedText>
              </View>

              <View style={styles.metricCardMuted}>
                <ThemedText type="defaultSemiBold">Last authoritative server checkpoint</ThemedText>
                {cashDashboard.summary.authoritativeExpectedClosingCashMinor === null ? (
                  <ThemedText>No authoritative totals are cached on this device yet.</ThemedText>
                ) : (
                  <>
                    <ThemedText>
                      Expected closing cash: {formatMinorCurrency(cashDashboard.summary.authoritativeExpectedClosingCashMinor, 'KES')}
                    </ThemedText>
                    {cashDashboard.summary.authoritativeCollectionsMinor !== null ? (
                      <ThemedText>
                        Collections: {formatMinorCurrency(cashDashboard.summary.authoritativeCollectionsMinor, 'KES')}
                      </ThemedText>
                    ) : null}
                    {cashDashboard.summary.authoritativeWithdrawalsMinor !== null ? (
                      <ThemedText>
                        Withdrawals: {formatMinorCurrency(cashDashboard.summary.authoritativeWithdrawalsMinor, 'KES')}
                      </ThemedText>
                    ) : null}
                    {cashDashboard.summary.authoritativeDeltaMinor !== null ? (
                      <ThemedText>
                        Local minus server checkpoint: {formatMinorCurrency(cashDashboard.summary.authoritativeDeltaMinor, 'KES')}
                      </ThemedText>
                    ) : null}
                    {cashDashboard.summary.authoritativeObservedAt ? (
                      <ThemedText>Checkpoint captured at: {cashDashboard.summary.authoritativeObservedAt}</ThemedText>
                    ) : null}
                  </>
                )}
              </View>

              <View style={styles.warningCard}>
                <ThemedText type="defaultSemiBold">Reconciliation draft</ThemedText>
                <ThemedText>
                  Save the declared cash locally first, then queue the intent for a later sync phase. Neither action is authoritative on-device.
                </ThemedText>
                <TextInput
                  placeholder="Declared cash minor"
                  value={reconciliationForm.declaredCashMinor}
                  keyboardType="number-pad"
                  onChangeText={(value) => setReconciliationForm((current) => ({ ...current, declaredCashMinor: value }))}
                  style={styles.input}
                />
                <TextInput
                  placeholder="Reconciliation notes"
                  value={reconciliationForm.notes}
                  onChangeText={(value) => setReconciliationForm((current) => ({ ...current, notes: value }))}
                  style={styles.input}
                />
                <View style={styles.row}>
                  <Pressable onPress={handleSaveReconciliationDraft} style={[styles.primaryButton, styles.rowButton]}>
                    <ThemedText style={styles.primaryButtonText}>Save local draft</ThemedText>
                  </Pressable>
                  <Pressable onPress={handleQueueReconciliationIntent} style={[styles.secondaryButton, styles.rowButton]}>
                    <ThemedText style={styles.secondaryButtonText}>Queue reconciliation intent</ThemedText>
                  </Pressable>
                </View>
                {cashDashboard.draft ? (
                  <View style={styles.metricCard}>
                    <ThemedText type="defaultSemiBold">Saved draft snapshot</ThemedText>
                    <ThemedText>Declared cash: {formatMinorCurrency(cashDashboard.draft.declaredCashMinor, 'KES')}</ThemedText>
                    <ThemedText>Projected local cash: {formatMinorCurrency(cashDashboard.draft.projectedCashOnHandMinor, 'KES')}</ThemedText>
                    <ThemedText>Variance: {formatMinorCurrency(cashDashboard.draft.varianceMinor, 'KES')}</ThemedText>
                    {cashDashboard.draft.queueOperationId ? (
                      <ThemedText>Queued intent: {cashDashboard.draft.queueOperationId}</ThemedText>
                    ) : (
                      <ThemedText>No reconciliation queue intent saved yet.</ThemedText>
                    )}
                  </View>
                ) : null}
                {cashDashboard.conflicts.length > 0 ? (
                  <View style={styles.metricCardMuted}>
                    <ThemedText type="defaultSemiBold">Preserved cash conflicts</ThemedText>
                    {cashDashboard.conflicts.map((conflict) => (
                      <ThemedText key={conflict.id}>{conflict.conflictType} recorded at {conflict.createdAt}</ThemedText>
                    ))}
                  </View>
                ) : null}
              </View>
            </>
          ) : (
            <View style={styles.metricCardMuted}>
              <ThemedText>No local cash session is open for the selected business date.</ThemedText>
              <ThemedText>Deposits and withdrawals are blocked locally until you open or resume the day.</ThemedText>
            </View>
          )}
        </View>

        <View style={styles.card}>
          <ThemedText type="subtitle">Queue Loan Creation</ThemedText>
          <ThemedText style={styles.sectionHint}>All amounts are entered in minor units to preserve deterministic math.</ThemedText>
          <TextInput placeholder="Member ID" value={loanForm.memberId} onChangeText={(value) => setLoanForm((current) => ({ ...current, memberId: value }))} style={styles.input} />
          <TextInput placeholder="Member label" value={loanForm.memberLabel} onChangeText={(value) => setLoanForm((current) => ({ ...current, memberLabel: value }))} style={styles.input} />
          <TextInput placeholder="Product code" value={loanForm.productCode} onChangeText={(value) => setLoanForm((current) => ({ ...current, productCode: value }))} style={styles.input} />
          <TextInput placeholder="Product name" value={loanForm.productName} onChangeText={(value) => setLoanForm((current) => ({ ...current, productName: value }))} style={styles.input} />
          <TextInput placeholder="Principal minor" value={loanForm.principalMinor} keyboardType="number-pad" onChangeText={(value) => setLoanForm((current) => ({ ...current, principalMinor: value }))} style={styles.input} />
          <View style={styles.row}>
            <TextInput placeholder="Months" value={loanForm.termMonths} keyboardType="number-pad" onChangeText={(value) => setLoanForm((current) => ({ ...current, termMonths: value }))} style={[styles.input, styles.rowInput]} />
            <TextInput placeholder="Rate bps" value={loanForm.monthlyInterestRateBps} keyboardType="number-pad" onChangeText={(value) => setLoanForm((current) => ({ ...current, monthlyInterestRateBps: value }))} style={[styles.input, styles.rowInput]} />
            <TextInput placeholder="Repayment day" value={loanForm.repaymentDayOfMonth} keyboardType="number-pad" onChangeText={(value) => setLoanForm((current) => ({ ...current, repaymentDayOfMonth: value }))} style={[styles.input, styles.rowInput]} />
          </View>
          <Pressable onPress={handleCreateLoan} style={styles.primaryButton}>
            <ThemedText style={styles.primaryButtonText}>Queue loan request</ThemedText>
          </Pressable>
        </View>

        <View style={styles.card}>
          <ThemedText type="subtitle">Queue Repayment Capture</ThemedText>
          <ThemedText style={styles.sectionHint}>Tap a loan card below to target it for repayment.</ThemedText>
          <TextInput placeholder="Loan ID" value={repaymentForm.loanId} onChangeText={(value) => setRepaymentForm((current) => ({ ...current, loanId: value }))} style={styles.input} />
          <TextInput placeholder="Repayment minor" value={repaymentForm.amountMinor} keyboardType="number-pad" onChangeText={(value) => setRepaymentForm((current) => ({ ...current, amountMinor: value }))} style={styles.input} />
          <Pressable onPress={handleCaptureRepayment} style={styles.primaryButton}>
            <ThemedText style={styles.primaryButtonText}>Queue repayment</ThemedText>
          </Pressable>
        </View>

        <View style={styles.card}>
          <ThemedText type="subtitle">Queue Savings Transaction</ThemedText>
          <ThemedText style={styles.sectionHint}>
            Mobile capture now stores offline evidence and local cash-session context. Queueing here never implies authoritative completion before sync, and deposits or withdrawals require an open local cash day.
          </ThemedText>

          <View style={styles.chipRow}>
            {(['deposit', 'withdrawal'] as const).map((entry) => (
              <Pressable
                key={entry}
                onPress={() => setTransactionForm((current) => ({ ...current, transactionType: entry }))}
                style={[
                  styles.choiceChip,
                  transactionForm.transactionType === entry ? styles.choiceChipActive : null,
                ]}>
                <ThemedText style={transactionForm.transactionType === entry ? styles.choiceChipActiveText : undefined}>
                  {entry === 'deposit' ? 'Deposit' : 'Withdrawal'}
                </ThemedText>
              </Pressable>
            ))}
          </View>

          <TextInput placeholder="Member ID" value={transactionForm.memberId} onChangeText={(value) => setTransactionForm((current) => ({ ...current, memberId: value }))} style={styles.input} />
          <TextInput placeholder="Account ID" value={transactionForm.accountId} onChangeText={(value) => setTransactionForm((current) => ({ ...current, accountId: value }))} style={styles.input} />
          <TextInput placeholder="Amount minor" value={transactionForm.amountMinor} keyboardType="number-pad" onChangeText={(value) => setTransactionForm((current) => ({ ...current, amountMinor: value }))} style={styles.input} />
          <TextInput placeholder="Available balance minor" value={transactionForm.availableBalanceMinor} keyboardType="number-pad" onChangeText={(value) => setTransactionForm((current) => ({ ...current, availableBalanceMinor: value }))} style={styles.input} />
          <TextInput placeholder="Plain-language note" value={transactionForm.note} onChangeText={(value) => setTransactionForm((current) => ({ ...current, note: value }))} style={styles.input} />

          {transactionForm.transactionType === 'withdrawal' ? (
            <View style={styles.warningCard}>
              <ThemedText type="defaultSemiBold">Withdrawal guardrails</ThemedText>
              <ThemedText>Offline withdrawals require identity confirmation, cash handoff confirmation, and local balance evidence.</ThemedText>
              <ThemedText>High-value offline withdrawals are blocked locally and must wait for sync or supervisor review.</ThemedText>
              <View style={styles.chipRow}>
                <Pressable
                  onPress={() => setTransactionForm((current) => ({ ...current, identityConfirmed: !current.identityConfirmed }))}
                  style={[styles.choiceChip, transactionForm.identityConfirmed ? styles.choiceChipActive : null]}>
                  <ThemedText style={transactionForm.identityConfirmed ? styles.choiceChipActiveText : undefined}>
                    {transactionForm.identityConfirmed ? 'Identity Confirmed' : 'Confirm Identity'}
                  </ThemedText>
                </Pressable>
                <Pressable
                  onPress={() => setTransactionForm((current) => ({ ...current, cashConfirmed: !current.cashConfirmed }))}
                  style={[styles.choiceChip, transactionForm.cashConfirmed ? styles.choiceChipActive : null]}>
                  <ThemedText style={transactionForm.cashConfirmed ? styles.choiceChipActiveText : undefined}>
                    {transactionForm.cashConfirmed ? 'Cash Confirmed' : 'Confirm Cash Handoff'}
                  </ThemedText>
                </Pressable>
              </View>
            </View>
          ) : null}

          <Pressable onPress={handleQueueTransaction} style={styles.primaryButton}>
            <ThemedText style={styles.primaryButtonText}>Queue transaction for sync</ThemedText>
          </Pressable>
        </View>

        <View style={styles.card}>
          <ThemedText type="subtitle">Local Loan Visibility</ThemedText>
          <ThemedText style={styles.sectionHint}>Provisional, stale, and conflict badges match the reconciliation states the local DB now stores.</ThemedText>
          {loans.length === 0 ? <ThemedText>No cached loans yet. Queue one above to verify offline capture.</ThemedText> : null}
          {loans.map((loan) => (
            <Pressable key={loan.loanId} onPress={() => setRepaymentForm((current) => ({ ...current, loanId: loan.loanId }))} style={styles.loanCard}>
              <View style={styles.loanHeaderRow}>
                <View>
                  <ThemedText type="defaultSemiBold">{loan.productName}</ThemedText>
                  <ThemedText>{loan.memberLabel}</ThemedText>
                </View>
                <View style={[styles.stateBadge, statusAccent(loan.syncState)]}>
                  <ThemedText style={styles.stateBadgeText}>{statusCopy(loan.syncState)}</ThemedText>
                </View>
              </View>
              <ThemedText>Loan ID: {loan.loanId}</ThemedText>
              <ThemedText>Outstanding principal: {formatMinorCurrency(loan.outstandingPrincipalMinor, loan.currencyCode)}</ThemedText>
              <ThemedText>Accrued interest: {formatMinorCurrency(loan.accruedInterestMinor, loan.currencyCode)}</ThemedText>
              <ThemedText>Total repaid locally: {formatMinorCurrency(loan.totalRepaidMinor, loan.currencyCode)}</ThemedText>
              <ThemedText>First due date: {loan.firstDueDate}</ThemedText>
              {loan.queueOperationId ? <ThemedText>Queue op: {loan.queueOperationId}</ThemedText> : null}
              {loan.staleAt ? <ThemedText>Stale since: {loan.staleAt}</ThemedText> : null}
              {loan.conflictReason ? <ThemedText>{loan.conflictReason}</ThemedText> : null}
            </Pressable>
          ))}
        </View>

        <View style={styles.card}>
          <ThemedText type="subtitle">Recent Local Transactions</ThemedText>
          <ThemedText style={styles.sectionHint}>
            These captures are local evidence only. Sync and server review determine the authoritative outcome.
          </ThemedText>
          {transactions.length === 0 ? <ThemedText>No local transaction captures yet.</ThemedText> : null}
          {transactions.slice().reverse().map((transaction) => (
            <View key={transaction.id} style={styles.transactionCard}>
              <View style={styles.loanHeaderRow}>
                <View>
                  <ThemedText type="defaultSemiBold">{transaction.transactionType.toUpperCase()}</ThemedText>
                  <ThemedText>{transaction.memberId}</ThemedText>
                </View>
                <View style={[
                  styles.stateBadge,
                  transaction.guardrailStatus === 'blocked'
                    ? styles.stateConflict
                    : transaction.guardrailStatus === 'review'
                      ? styles.stateStale
                      : styles.stateProvisional,
                ]}>
                  <ThemedText style={styles.stateBadgeText}>
                    {transaction.guardrailStatus === 'review' ? 'Local review flag' : 'Queued locally'}
                  </ThemedText>
                </View>
              </View>
              <ThemedText>{formatMinorCurrency(transaction.amountMinor, transaction.currencyCode)}</ThemedText>
              <ThemedText>Envelope: {transaction.offlineEnvelopeId}</ThemedText>
              <ThemedText>Integrity: {transaction.integrityHash}</ThemedText>
              <ThemedText>Client recorded: {transaction.clientRecordedAt}</ThemedText>
              {transaction.fraudHints.length > 0 ? (
                <View style={styles.hintList}>
                  {transaction.fraudHints.map((hint) => (
                    <View key={`${transaction.id}_${hint.code}`} style={styles.hintChip}>
                      <ThemedText style={styles.hintChipText}>{hint.code}</ThemedText>
                    </View>
                  ))}
                </View>
              ) : (
                <ThemedText>No local fraud hints recorded.</ThemedText>
              )}
            </View>
          ))}
        </View>

        <Pressable onPress={() => signOut()} style={styles.secondaryButton}>
          <ThemedText style={styles.secondaryButtonText}>Sign out</ThemedText>
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
    gap: 16,
    borderRadius: 24,
    backgroundColor: '#ffffff',
    padding: 20,
  },
  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  statusPillOnline: {
    backgroundColor: '#dcfce7',
  },
  statusPillOffline: {
    backgroundColor: '#fef3c7',
  },
  statusText: {
    fontWeight: '600',
  },
  noticeCard: {
    borderRadius: 16,
    backgroundColor: '#eff6ff',
    padding: 14,
  },
  noticeText: {
    color: '#1d4ed8',
    fontWeight: '600',
  },
  sectionHint: {
    color: '#4b5563',
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 14,
    backgroundColor: '#f9fafb',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  rowInput: {
    flex: 1,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  choiceChip: {
    borderRadius: 999,
    backgroundColor: '#ecf2ea',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  choiceChipActive: {
    backgroundColor: '#14532d',
  },
  choiceChipActiveText: {
    color: '#ffffff',
    fontWeight: '700',
  },
  primaryButton: {
    alignItems: 'center',
    borderRadius: 16,
    backgroundColor: '#14532d',
    paddingVertical: 14,
  },
  primaryButtonDisabled: {
    backgroundColor: '#6b7280',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '700',
  },
  warningCard: {
    gap: 10,
    borderRadius: 18,
    backgroundColor: '#fff7ed',
    padding: 16,
  },
  metricCard: {
    gap: 6,
    borderRadius: 18,
    backgroundColor: '#f8fafc',
    padding: 16,
  },
  metricCardMuted: {
    gap: 6,
    borderRadius: 18,
    backgroundColor: '#f3f4f6',
    padding: 16,
  },
  loanCard: {
    gap: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#fafaf9',
    padding: 16,
  },
  transactionCard: {
    gap: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#fafaf9',
    padding: 16,
  },
  loanHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  stateBadge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  stateBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  stateAuthoritative: {
    backgroundColor: '#dcfce7',
  },
  stateProvisional: {
    backgroundColor: '#dbeafe',
  },
  stateStale: {
    backgroundColor: '#fef3c7',
  },
  stateConflict: {
    backgroundColor: '#fee2e2',
  },
  hintList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  hintChip: {
    borderRadius: 999,
    backgroundColor: '#eef2ff',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  hintChipText: {
    color: '#1d4ed8',
    fontSize: 12,
    fontWeight: '700',
  },
  secondaryButton: {
    alignItems: 'center',
    borderRadius: 16,
    backgroundColor: '#111827',
    paddingVertical: 14,
  },
  secondaryButtonText: {
    color: '#ffffff',
    fontWeight: '600',
  },
  rowButton: {
    flex: 1,
  },
})