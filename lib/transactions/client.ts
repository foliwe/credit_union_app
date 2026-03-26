type FinancialTransactionType =
  | 'deposit'
  | 'withdrawal'
  | 'loan_disbursement'
  | 'loan_repayment'
  | 'adjustment'

type TransactionSourceChannel = 'mobile_online' | 'mobile_offline_sync' | 'admin' | 'system'

type SupabaseSession = {
  access_token: string
}

type SupabaseInvokeError = {
  message: string
}

type TransactionSyncSupabaseClient = {
  auth: {
    getSession(): Promise<{ data: { session: SupabaseSession | null }; error: SupabaseInvokeError | null }>
  }
  functions: {
    invoke(
      functionName: string,
      options: { body: unknown; headers?: Record<string, string> }
    ): Promise<{ data: unknown; error: SupabaseInvokeError | null }>
  }
}

export type TransactionIngestRequest = {
  action: 'ingest_transaction'
  input: {
    queue: {
      id?: string
      operationId: string
      operationType: string
      localTransactionId?: string
      actorId?: string
      branchId?: string
      deviceInstallationId?: string
      lastKnownServerVersion?: string | null
      payload: Record<string, unknown>
    }
  }
}

export type TransactionIngestResult =
  | {
      status: 'ingested'
      idempotencyKey: string
      transaction: {
        id: string
        branchId: string
        memberId: string | null
        loanId: string | null
        capturedBy: string | null
        transactionType: FinancialTransactionType
        sourceChannel: TransactionSourceChannel
        currencyCode: string
        amountMinor: number
        occurredAt: string
        clientRecordedAt: string | null
        idempotencyKey: string
        clientTransactionId: string | null
        externalReference: string | null
        deviceInstallationId: string | null
        offlineEnvelopeId: string | null
        offlineBatchId: string | null
        integrityHash: string | null
        metadata: Record<string, unknown>
        createdAt: string
      }
      duplicateSignalRecorded: boolean
      fraudSignals: Array<Record<string, unknown>>
      fraudAlerts: Array<Record<string, unknown>>
    }
  | {
      status: 'duplicate'
      idempotencyKey: string
      duplicateReason?: string
      transaction: {
        id: string
        branchId: string
        memberId: string | null
        loanId: string | null
        capturedBy: string | null
        transactionType: FinancialTransactionType
        sourceChannel: TransactionSourceChannel
        currencyCode: string
        amountMinor: number
        occurredAt: string
        clientRecordedAt: string | null
        idempotencyKey: string
        clientTransactionId: string | null
        externalReference: string | null
        deviceInstallationId: string | null
        offlineEnvelopeId: string | null
        offlineBatchId: string | null
        integrityHash: string | null
        metadata: Record<string, unknown>
        createdAt: string
      }
    }

export type AgentCashAction =
  | 'agent.cash.open'
  | 'agent.cash.current_state'
  | 'agent.cash.reconcile.submit'
  | 'agent.cash.reconcile.approve'
  | 'agent.cash.reconcile.reject'

export type AgentCashSuccessEnvelope = {
  ok: true
  action: AgentCashAction
  operationId: string | null
  replayed: boolean
  outcome: 'accepted' | 'duplicate'
  data: {
    branchId: string
    sessionId: string
    businessDate: string
    status: 'open' | 'reconciliation_submitted' | 'closed'
    serverVersion: string
    policy: {
      maxSessionCarryMinor: number | null
      minimumReserveMinor: number
      businessTimezone: string
    }
    totals: {
      openingFloatMinor: number
      depositsMinor: number
      loanRepaymentsMinor: number
      cashAdjustmentsInMinor: number
      withdrawalsMinor: number
      loanDisbursementsMinor: number
      cashAdjustmentsOutMinor: number
      expectedClosingCashMinor: number
      declaredCashMinor?: number
      mismatchMinor?: number
    }
    reconciliation: {
      reconciliationId: string
      status: 'submitted' | 'approved' | 'rejected'
      declaredCashMinor: number
      expectedClosingCashMinor: number
      mismatchMinor: number
    } | null
  }
}

export type AgentCashRequest =
  | {
      action: 'agent.cash.current_state'
      input: {
        branchId?: string
      }
    }
  | {
      action: 'agent.cash.reconcile.submit'
      input: {
        operationId: string
        sessionId?: string
        declaredCashMinor: number
        submittedAt: string
        notes?: string
        counts?: Record<string, unknown>
        lastKnownServerVersion: string | null
      }
    }

export type MobileTransactionSyncTransport = {
  invokeTransactionIngest(request: TransactionIngestRequest): Promise<TransactionIngestResult>
  invokeAgentCash(request: AgentCashRequest): Promise<AgentCashSuccessEnvelope>
}

export class TransactionSyncTransportError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'TransactionSyncTransportError'
    this.code = code
    this.retryable = retryable
  }
}

export class TransactionSyncRequestError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>
  readonly action: string | null
  readonly operationId: string | null

  constructor(
    code: string,
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>,
    action: string | null = null,
    operationId: string | null = null
  ) {
    super(message)
    this.name = 'TransactionSyncRequestError'
    this.code = code
    this.retryable = retryable
    this.details = details
    this.action = action
    this.operationId = operationId
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toTransactionRequestError(payload: Record<string, unknown>, request: TransactionIngestRequest) {
  const error = isRecord(payload.error) ? payload.error : null
  const code = typeof error?.code === 'string' ? error.code : 'transaction_sync_request_failed'
  const message = typeof error?.message === 'string' ? error.message : 'Transaction sync request failed'
  const details = isRecord(error?.details) ? error.details : undefined

  return new TransactionSyncRequestError(code, message, false, details, request.action, request.input.queue.operationId)
}

function toAgentCashRequestError(payload: Record<string, unknown>) {
  const error = isRecord(payload.error) ? payload.error : null
  const code = typeof error?.code === 'string' ? error.code : 'agent_cash_request_failed'
  const message = typeof error?.message === 'string' ? error.message : 'Agent cash request failed'
  const retryable = typeof error?.retryable === 'boolean' ? error.retryable : false
  const details = isRecord(error?.details) ? error.details : undefined
  const action = typeof payload.action === 'string' ? payload.action : null
  const operationId = typeof payload.operationId === 'string' ? payload.operationId : null

  return new TransactionSyncRequestError(code, message, retryable, details, action, operationId)
}

function assertTransactionIngestResult(
  value: unknown,
  request: TransactionIngestRequest
): TransactionIngestResult {
  if (isRecord(value) && (value.status === 'ingested' || value.status === 'duplicate')) {
    return value as TransactionIngestResult
  }

  if (isRecord(value) && isRecord(value.error)) {
    throw toTransactionRequestError(value, request)
  }

  throw new TransactionSyncTransportError(
    'invalid_transaction_ingest_response',
    'Transaction ingest returned an unexpected response payload',
    false
  )
}

function assertAgentCashSuccessEnvelope(value: unknown): AgentCashSuccessEnvelope {
  if (isRecord(value) && value.ok === true) {
    return value as AgentCashSuccessEnvelope
  }

  if (isRecord(value) && value.ok === false) {
    throw toAgentCashRequestError(value)
  }

  throw new TransactionSyncTransportError(
    'invalid_agent_cash_response',
    'Agent cash returned an unexpected response payload',
    false
  )
}

export function createMobileTransactionSyncTransport(
  supabase?: TransactionSyncSupabaseClient
): MobileTransactionSyncTransport {
  async function resolveSupabaseClient() {
    return supabase ??
      ((await import('../auth/supabase')).createMobileSupabaseClient() as unknown as TransactionSyncSupabaseClient)
  }

  async function invokeFunction(functionName: string, body: unknown) {
    const resolvedSupabase = await resolveSupabaseClient()
    const {
      data: { session },
      error: sessionError,
    } = await resolvedSupabase.auth.getSession()

    if (sessionError) {
      throw new TransactionSyncTransportError('transaction_sync_session_error', sessionError.message, true)
    }

    if (!session?.access_token) {
      throw new TransactionSyncTransportError(
        'missing_supabase_session',
        'An active Supabase session is required before mobile cash sync can run',
        false
      )
    }

    const { data, error } = await resolvedSupabase.functions.invoke(functionName, {
      body,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    })

    if (error) {
      throw new TransactionSyncTransportError('transaction_sync_transport_error', error.message, true)
    }

    return data
  }

  return {
    async invokeTransactionIngest(request) {
      const response = await invokeFunction('transaction-ingest', request)
      return assertTransactionIngestResult(response, request)
    },
    async invokeAgentCash(request) {
      const response = await invokeFunction('agent-cash', request)
      return assertAgentCashSuccessEnvelope(response)
    },
  }
}