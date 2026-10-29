// Types of the Storage module, shared by the main process, the preload bridge and the renderer. No runtime code.

export type ArtifactClass = 'protected' | 'keep' | 'review' | 'delete-candidate' | 'expired'
export type ArtifactCategory = 'installer' | 'build' | 'report' | 'logs' | 'evidence' | 'other'
export type PlatformTag = 'windows' | 'linux' | 'macos' | 'android' | 'ios' | 'unknown'

/** Why an artifact got its class. Stable codes for tests and filters; `reason` is the sentence the user reads. */
export type ReasonCode =
  | 'expired' | 'repo-protected' | 'pinned' | 'evidence' | 'doc-cited' | 'release' | 'open-pr' | 'run-active'
  | 'newest-successful' | 'last-installer' | 'recent' | 'superseded-build' | 'obsolete-report' | 'superseded-failed'
  | 'failed-run' | 'metadata-missing' | 'context-incomplete' | 'category-unreviewed' | 'unclassified' | 'category-disabled' | 'no-newer-build'

export type RunInfo = {
  id: number
  name: string | null
  path: string | null
  status: string | null
  conclusion: string | null
  event: string | null
  runNumber: number | null
  headBranch: string | null
  headSha: string | null
  htmlUrl: string
  pullNumbers: number[]
}

export type Artifact = {
  id: number
  repo: string // owner/name
  name: string
  sizeBytes: number
  createdAt: string | null
  expiresAt: string | null
  expired: boolean
  runId: number | null
  headBranch: string | null
  headSha: string | null
  run: RunInfo | null
  category: ArtifactCategory
  platform: PlatformTag
  class: ArtifactClass
  reasonCode: ReasonCode
  reason: string
  pinned: boolean
}

export type CacheEntry = { key: string; ref: string | null; sizeBytes: number; lastAccessedAt: string | null; createdAt: string | null }
export type PackageEntry = { name: string; type: string; visibility: string | null; versionCount: number | null; repository: string | null; updatedAt: string | null }

/** What could not be read, per area, so a missing number is never mistaken for zero. */
export type RepoLimit = { area: 'artifacts' | 'runs' | 'pulls' | 'releases' | 'docs' | 'caches'; message: string }

export type RepoInventory = {
  repo: string
  private: boolean
  archived: boolean
  canDelete: boolean
  scannedAt: string
  protectedRepo: boolean
  artifacts: Artifact[]
  cacheBytes: number | null
  cacheCount: number | null
  caches: CacheEntry[]
  limits: RepoLimit[]
  error: string | null
  /** Context lookups that succeeded; a failed one downgrades delete candidates to Review. */
  context: { runs: boolean; pulls: boolean; releases: boolean; docs: boolean }
}

export type PackagesInventory = { available: boolean; message: string | null; packages: PackageEntry[] }

export type BillingItem = { product: string; sku: string; unit: string; quantity: number; gross: number | null; net: number | null }
export type BillingInfo = {
  available: boolean
  message: string | null
  period: string | null
  items: BillingItem[]
}

export type AuthState =
  | { state: 'ok'; login: string; scopes: string[] | null; scopesKnown: boolean; canWrite: boolean | null; plan: string | null }
  | { state: 'no-gh'; message: string }
  | { state: 'unauthenticated'; message: string }
  | { state: 'error'; message: string }

export type ScanProgress = { running: boolean; phase: 'idle' | 'repos' | 'inventory' | 'extras'; done: number; total: number; current: string | null; startedAt: string | null; cancelled: boolean }

export type StorageAlert = { id: string; kind: 'high-storage' | 'growth' | 'repeated-builds' | 'old-builds' | 'quota-error' | 'cleanup-failed' | 'scan-failed'; severity: 'info' | 'warn'; message: string; repo?: string; at: string }

export type Snapshot = {
  scannedAt: string | null
  /** Last scan that completed for every selected repository without a fatal error. */
  lastSuccessfulScanAt: string | null
  login: string | null
  repos: RepoInventory[]
  packages: PackagesInventory
  billing: BillingInfo
  limitations: string[]
  alerts: StorageAlert[]
}

export type Mode = 'manual' | 'recommend' | 'auto-safe'
export type Frequency = 'daily' | 'weekly' | 'monthly'

export type RepoPolicy = {
  mode: Mode
  keepLatest: number // newest successful builds kept per artifact family
  tempDays: number // superseded temporary builds younger than this are kept
  reportDays: number // obsolete CI reports and logs younger than this are kept
  deleteCategories: ArtifactCategory[] // categories that may ever become delete candidates
  evidencePatterns: string[] // artifact or workflow names (case-insensitive substrings) that are protected
  largeDeleteBytes: number // automatic cleanup above this total waits for approval
  presetId: string | null
  /** Hash of the policy fields the user approved for automatic safe cleanup; a change voids it. */
  approvedHash: string | null
  approvedAt: string | null
}

export type StorageSettings = {
  scheduleEnabled: boolean // master switch for periodic scans, off by default
  frequency: Frequency
  scope: 'writable' | 'owned'
  includeArchived: boolean
  notify: boolean // system notifications for scheduled results (in-app alerts are always on)
  alerts: { highBytes: number | null; growth: boolean; repeatedBuilds: boolean; oldBuilds: boolean }
}

export type Pin = { repo: string; artifactId: number; name: string; at: string }

export type StorageConfig = {
  settings: StorageSettings
  defaultPolicy: RepoPolicy
  policies: Record<string, RepoPolicy>
  protectedRepos: string[]
  pins: Pin[]
}

export type Recommendation = { at: string; refs: ArtifactRef[]; bytes: number }
export type ArtifactRef = { repo: string; id: number }

export type SchedulerState = {
  enabled: boolean
  frequency: Frequency
  lastRunAt: string | null
  nextRunAt: string | null
  lastCleanupAt: string | null
  lastCleanupSummary: string | null
  lastError: string | null
  /** Honest scope of the schedule: it runs only while GitManager is running. */
  note: string
}

export type PlanItem = {
  ref: ArtifactRef
  name: string
  sizeBytes: number
  createdAt: string | null
  runId: number | null
  runUrl: string | null
  class: ArtifactClass
  reasonCode: ReasonCode
  reason: string
}
export type CleanupPlan = {
  items: PlanItem[]
  /** Requested but not allowed: protected, kept, expired, or unknown. */
  excluded: (PlanItem & { why: string })[]
  repos: string[]
  totalBytes: number
  /** Candidates that were not selected. */
  unselectedCandidates: number
}

export type Outcome =
  | 'deleted' // GitHub returned 204 and the artifact is gone on re-listing
  | 'deleted-unconfirmed' // GitHub returned 204 but the artifact is still listed
  | 'already-gone'
  | 'skipped-changed' // metadata or classification changed since the scan
  | 'skipped-protected'
  | 'skipped-not-found'
  | 'skipped-dry-run'
  | 'denied' // authentication or permission
  | 'rate-limited'
  | 'failed'
  | 'not-attempted' // interrupted or cancelled before this artifact

export type ItemResult = { ref: ArtifactRef; name: string; sizeBytes: number; runId: number | null; outcome: Outcome; message: string | null }

export type OperationResult = {
  opId: string
  trigger: 'manual' | 'scheduled'
  dryRun: boolean
  startedAt: string
  finishedAt: string
  items: ItemResult[]
  confirmedDeleted: number
  confirmedBytes: number
  interrupted: boolean
  stopReason: string | null
}

export type OperationProgress = { opId: string | null; running: boolean; done: number; total: number; current: string | null; cancelling: boolean }

export type AuditEntry = {
  seq: number
  at: string
  opId: string
  type: 'attempt' | 'result'
  trigger: 'manual' | 'scheduled'
  repo: string
  artifactId: number
  name: string
  runId: number | null
  sizeBytes: number
  outcome?: Outcome
  message?: string | null
  prev: string
  hash: string
}

export type AuditView = { entries: AuditEntry[]; total: number; intact: boolean; brokenAt: number | null; unresolved: number }

export type StorageState = {
  snapshot: Snapshot | null
  auth: AuthState | null
  config: StorageConfig
  scan: ScanProgress
  operation: OperationProgress
  scheduler: SchedulerState
  recommendation: Recommendation | null
  lastOperation: OperationResult | null
  presets: { id: string; label: string; description: string; policy: Partial<RepoPolicy> }[]
}

export type OpenTarget =
  | { kind: 'run'; repo: string; runId: number }
  | { kind: 'billing' }
  | { kind: 'billing-docs' }
  | { kind: 'scopes' }
  | { kind: 'repo-actions'; repo: string }
