export type LoanStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'active'
  | 'closed'
  | 'rejected'
  | 'written_off'

export type LoanRepaymentStatus = 'pending_review' | 'approved' | 'rejected' | 'applied'

export type LoanScheduleInstallment = {
  installmentNumber: number
  dueDate: string
  outstandingInterestMinor: number
  outstandingPrincipalMinor: number
}

export type LoanScheduleState = {
  snapshotId?: string
  snapshotSequence: number
  generatedAt: string
  effectiveFrom: string
  installments: LoanScheduleInstallment[]
}

export type LoanOrchestrationSuccessEnvelope = {
  ok: true
  action: 'loan.create' | 'loan.repayment.capture'
  operationId: string
  replayed: boolean
  outcome: 'accepted' | 'duplicate'
  data: {
    branchId: string
    serverLoanId: string | null
    serverRepaymentId: string | null
    clientLoanId: string | null
    clientRepaymentId: string | null
    status: LoanStatus
    repaymentStatus: LoanRepaymentStatus | null
    serverVersion: string
    totals: {
      principalMinor: number
      outstandingPrincipalMinor: number
      accruedInterestMinor: number
      totalRepaidMinor: number
    }
    schedule: LoanScheduleState | null
    event: {
      eventType: string
      occurredAt: string
      actorId: string | null
    } | null
  }
}

export type LoanCreateRequest = {
  action: 'loan.create'
  input: {
    operationId: string
    branchId?: string
    clientLoanId: string
    memberId: string
    submittedAt: string
    firstDueDate?: string
    product: {
      productCode: string
      productName?: string
      currencyCode: string
      principalMinor: number
      termMonths: number
      monthlyInterestRateBps: number
      repaymentDayOfMonth: number
      interestStrategy: 'monthly_remaining_principal'
      repaymentAllocationStrategy: 'interest_then_principal'
    }
    metadata?: Record<string, unknown>
  }
}

export type LoanRepaymentCaptureRequest = {
  action: 'loan.repayment.capture'
  input: {
    operationId: string
    loanId: string
    memberId: string
    clientRepaymentId: string
    amountMinor: number
    currencyCode: string
    effectiveAt: string
    capturedAt: string
    note?: string
    lastKnownServerVersion: string | null
  }
}

export type LoanOrchestrationRequest = LoanCreateRequest | LoanRepaymentCaptureRequest

type SupabaseSession = {
  access_token: string
}

type SupabaseInvokeError = {
  message: string
}

export type LoanOrchestrationSupabaseClient = {
  auth: {
    getSession(): Promise<{ data: { session: SupabaseSession | null }; error: SupabaseInvokeError | null }>
  }
  functions: {
    invoke(
      functionName: string,
      options: { body: LoanOrchestrationRequest; headers?: Record<string, string> }
    ): Promise<{ data: unknown; error: SupabaseInvokeError | null }>
  }
}

export class LoanOrchestrationTransportError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'LoanOrchestrationTransportError'
    this.code = code
    this.retryable = retryable
  }
}

export class LoanOrchestrationRequestError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>
  readonly action: LoanOrchestrationRequest['action'] | null
  readonly operationId: string | null

  constructor(
    code: string,
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>,
    action: LoanOrchestrationRequest['action'] | null = null,
    operationId: string | null = null
  ) {
    super(message)
    this.name = 'LoanOrchestrationRequestError'
    this.code = code
    this.retryable = retryable
    this.details = details
    this.action = action
    this.operationId = operationId
  }
}

export type LoanOrchestrationTransport = {
  invoke(request: LoanOrchestrationRequest): Promise<LoanOrchestrationSuccessEnvelope>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toRequestError(payload: Record<string, unknown>) {
  const error = isRecord(payload.error) ? payload.error : null
  const code = typeof error?.code === 'string' ? error.code : 'loan_orchestration_request_failed'
  const message = typeof error?.message === 'string' ? error.message : 'Loan orchestration request failed'
  const retryable = typeof error?.retryable === 'boolean' ? error.retryable : false
  const details = isRecord(error?.details) ? error.details : undefined
  const action = payload.action === 'loan.create' || payload.action === 'loan.repayment.capture' ? payload.action : null
  const operationId = typeof payload.operationId === 'string' ? payload.operationId : null

  return new LoanOrchestrationRequestError(code, message, retryable, details, action, operationId)
}

function assertSuccessEnvelope(value: unknown): LoanOrchestrationSuccessEnvelope {
  if (!isRecord(value) || value.ok !== true) {
    if (isRecord(value) && value.ok === false) {
      throw toRequestError(value)
    }

    throw new LoanOrchestrationTransportError(
      'invalid_loan_orchestration_response',
      'Loan orchestration returned an unexpected response payload',
      false
    )
  }

  return value as LoanOrchestrationSuccessEnvelope
}

export function createLoanOrchestrationTransport(
  supabase?: LoanOrchestrationSupabaseClient
): LoanOrchestrationTransport {
  return {
    async invoke(request) {
      const resolvedSupabase = supabase ??
        ((await import('../auth/supabase')).createMobileSupabaseClient() as unknown as LoanOrchestrationSupabaseClient)

      const {
        data: { session },
        error: sessionError,
      } = await resolvedSupabase.auth.getSession()

      if (sessionError) {
        throw new LoanOrchestrationTransportError('loan_orchestration_session_error', sessionError.message, true)
      }

      if (!session?.access_token) {
        throw new LoanOrchestrationTransportError(
          'missing_supabase_session',
          'An active Supabase session is required before loan sync can run',
          false
        )
      }

      const { data, error } = await resolvedSupabase.functions.invoke('loan-orchestration', {
        body: request,
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      if (error) {
        throw new LoanOrchestrationTransportError('loan_orchestration_transport_error', error.message, true)
      }

      return assertSuccessEnvelope(data)
    },
  }
}