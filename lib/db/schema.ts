export const LOCAL_DATABASE_NAME = 'microfinance-local.db'
export const LOCAL_SCHEMA_VERSION = 4

export const REQUIRED_TABLES = [
  'cached_accounts',
  'cached_loan_repayment_outcomes',
  'cached_loan_schedule_snapshots',
  'cached_loans',
  'cached_members',
  'local_agent_cash_conflicts',
  'local_agent_cash_reconciliation_drafts',
  'local_agent_cash_sessions',
  'local_transactions',
  'queue_entries',
  'sync_checkpoints',
  'sync_conflicts',
  'sync_runs',
] as const

export const SCHEMA_V1_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS cached_members (
      id TEXT PRIMARY KEY NOT NULL,
      branch_id TEXT NOT NULL,
      full_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      server_version TEXT,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS cached_accounts (
      id TEXT PRIMARY KEY NOT NULL,
      member_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      account_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      server_version TEXT,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_transactions (
      id TEXT PRIMARY KEY NOT NULL,
      client_transaction_id TEXT NOT NULL UNIQUE,
      member_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      transaction_type TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      currency_code TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      device_installation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'local_pending',
      queue_operation_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS queue_entries (
      id TEXT PRIMARY KEY NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      operation_type TEXT NOT NULL,
      local_transaction_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      device_installation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS sync_checkpoints (
      scope TEXT PRIMARY KEY NOT NULL,
      last_pulled_at TEXT,
      server_cursor TEXT,
      last_known_server_version TEXT,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      error_message TEXT,
      last_known_server_version TEXT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id TEXT PRIMARY KEY NOT NULL,
      queue_entry_id TEXT NOT NULL,
      local_transaction_id TEXT,
      conflict_type TEXT NOT NULL,
      server_payload_json TEXT,
      local_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_cached_members_branch ON cached_members (branch_id)',
  'CREATE INDEX IF NOT EXISTS idx_cached_accounts_member ON cached_accounts (member_id)',
  'CREATE INDEX IF NOT EXISTS idx_local_transactions_status ON local_transactions (status, captured_at)',
  'CREATE INDEX IF NOT EXISTS idx_queue_entries_status ON queue_entries (status, next_attempt_at)',
  'CREATE INDEX IF NOT EXISTS idx_sync_conflicts_queue_entry ON sync_conflicts (queue_entry_id)',
] as const

export const SCHEMA_V2_STATEMENTS = [
  'ALTER TABLE queue_entries ADD COLUMN last_known_server_version TEXT',
] as const

export const SCHEMA_V3_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS cached_loans (
      id TEXT PRIMARY KEY NOT NULL,
      server_loan_id TEXT UNIQUE,
      client_loan_id TEXT NOT NULL UNIQUE,
      branch_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      product_code TEXT NOT NULL,
      product_name TEXT NOT NULL,
      currency_code TEXT NOT NULL,
      principal_minor INTEGER NOT NULL,
      outstanding_principal_minor INTEGER NOT NULL,
      accrued_interest_minor INTEGER NOT NULL DEFAULT 0,
      total_repaid_minor INTEGER NOT NULL DEFAULT 0,
      term_months INTEGER NOT NULL,
      monthly_interest_rate_bps INTEGER NOT NULL,
      repayment_day_of_month INTEGER NOT NULL,
      interest_strategy TEXT NOT NULL,
      repayment_allocation_strategy TEXT NOT NULL,
      status TEXT NOT NULL,
      sync_state TEXT NOT NULL DEFAULT 'authoritative',
      source_queue_operation_id TEXT,
      current_schedule_snapshot_id TEXT,
      stale_at TEXT,
      last_reconciled_at TEXT,
      server_version TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS cached_loan_schedule_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      loan_id TEXT NOT NULL,
      snapshot_sequence INTEGER NOT NULL,
      generated_at TEXT NOT NULL,
      effective_from TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'current',
      sync_state TEXT NOT NULL DEFAULT 'authoritative',
      outstanding_principal_minor INTEGER NOT NULL,
      accrued_interest_minor INTEGER NOT NULL DEFAULT 0,
      schedule_json TEXT NOT NULL,
      source_queue_operation_id TEXT,
      server_version TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (loan_id, snapshot_sequence)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS cached_loan_repayment_outcomes (
      id TEXT PRIMARY KEY NOT NULL,
      repayment_id TEXT NOT NULL UNIQUE,
      loan_id TEXT NOT NULL,
      local_transaction_id TEXT,
      queue_operation_id TEXT NOT NULL,
      source_schedule_snapshot_id TEXT,
      resulting_schedule_snapshot_id TEXT,
      amount_minor INTEGER NOT NULL,
      currency_code TEXT NOT NULL,
      effective_at TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_review',
      sync_state TEXT NOT NULL DEFAULT 'provisional',
      allocations_json TEXT NOT NULL,
      resulting_installments_json TEXT NOT NULL,
      remaining_amount_minor INTEGER NOT NULL,
      total_allocated_minor INTEGER NOT NULL,
      resulting_outstanding_principal_minor INTEGER NOT NULL,
      resulting_accrued_interest_minor INTEGER NOT NULL,
      server_version TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_cached_loans_member ON cached_loans (member_id, sync_state, updated_at)',
  'CREATE INDEX IF NOT EXISTS idx_cached_loans_queue ON cached_loans (source_queue_operation_id)',
  'CREATE INDEX IF NOT EXISTS idx_cached_loan_schedule_snapshots_loan ON cached_loan_schedule_snapshots (loan_id, status, snapshot_sequence)',
  'CREATE INDEX IF NOT EXISTS idx_cached_loan_repayment_outcomes_loan ON cached_loan_repayment_outcomes (loan_id, created_at)',
] as const

export const AGENT_CASH_SCHEMA_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS local_agent_cash_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      server_session_id TEXT,
      actor_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      device_installation_id TEXT NOT NULL,
      business_date TEXT NOT NULL,
      business_timezone TEXT NOT NULL,
      opening_float_minor INTEGER NOT NULL,
      max_session_carry_minor INTEGER,
      minimum_reserve_minor INTEGER NOT NULL DEFAULT 0,
      authoritative_expected_closing_cash_minor INTEGER,
      authoritative_collections_minor INTEGER,
      authoritative_withdrawals_minor INTEGER,
      authoritative_observed_at TEXT,
      last_known_server_version TEXT,
      opened_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (actor_id, branch_id, business_date)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_agent_cash_reconciliation_drafts (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      declared_cash_minor INTEGER NOT NULL,
      notes TEXT,
      counts_json TEXT NOT NULL DEFAULT '{}',
      projected_cash_on_hand_minor INTEGER NOT NULL,
      variance_minor INTEGER NOT NULL,
      queue_operation_id TEXT,
      last_known_server_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES local_agent_cash_sessions (id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_agent_cash_conflicts (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      queue_operation_id TEXT,
      conflict_type TEXT NOT NULL,
      server_payload_json TEXT,
      local_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY (session_id) REFERENCES local_agent_cash_sessions (id)
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_local_agent_cash_sessions_actor_date ON local_agent_cash_sessions (actor_id, branch_id, business_date)',
  'CREATE INDEX IF NOT EXISTS idx_local_agent_cash_drafts_session ON local_agent_cash_reconciliation_drafts (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_local_agent_cash_conflicts_session ON local_agent_cash_conflicts (session_id, created_at)',
] as const

export const SCHEMA_V4_STATEMENTS = [
  'ALTER TABLE local_transactions ADD COLUMN client_recorded_at TEXT',
  'ALTER TABLE local_transactions ADD COLUMN offline_envelope_id TEXT',
  'ALTER TABLE local_transactions ADD COLUMN offline_batch_id TEXT',
  'ALTER TABLE local_transactions ADD COLUMN integrity_hash TEXT',
  "ALTER TABLE local_transactions ADD COLUMN fraud_hints_json TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE local_transactions ADD COLUMN guardrail_status TEXT NOT NULL DEFAULT 'clear'",
  "ALTER TABLE local_transactions ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}'",
  'UPDATE local_transactions SET client_recorded_at = captured_at WHERE client_recorded_at IS NULL',
  'UPDATE local_transactions SET offline_envelope_id = queue_operation_id WHERE offline_envelope_id IS NULL',
  "UPDATE local_transactions SET offline_batch_id = substr(captured_at, 1, 10) WHERE offline_batch_id IS NULL",
  'UPDATE local_transactions SET integrity_hash = queue_operation_id WHERE integrity_hash IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_local_transactions_member_type_amount ON local_transactions (member_id, transaction_type, amount_minor, occurred_at)',
  'CREATE INDEX IF NOT EXISTS idx_local_transactions_envelope ON local_transactions (offline_envelope_id)',
  ...AGENT_CASH_SCHEMA_STATEMENTS,
] as const
