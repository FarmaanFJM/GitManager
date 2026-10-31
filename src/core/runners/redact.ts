// Secrets never reach logs, previews, diagnostics or error messages. Registration and removal tokens are short-lived, but a
// leaked one still registers a runner that receives repository secrets, so every line of process output passes through here.

const PATTERNS: RegExp[] = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, // GitHub personal, OAuth, server, user and refresh tokens
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(A[A-Z0-9]{28})\b/g, // runner registration and removal tokens (29 characters starting with A)
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, // JWTs
  /(--token|--pat|--windowslogonpassword|--password)(\s+|=)(\S+)/gi,
  /(authorization:\s*)(bearer|basic|token)?\s*\S+/gi,
  /(RUNNER_TOKEN|GH_TOKEN|GITHUB_TOKEN|ACTIONS_RUNNER_INPUT_TOKEN)(=|:\s*)(\S+)/gi,
]

const MASK = '[redacted]'

/** Replaces anything that looks like a credential, and every value in `known`, with a placeholder. */
export function redact(text: string, known: readonly string[] = []): string {
  let out = text
  for (const k of known) if (k && k.length >= 6) out = out.split(k).join(MASK)
  out = out.replace(PATTERNS[0], MASK).replace(PATTERNS[1], MASK).replace(PATTERNS[2], MASK).replace(PATTERNS[3], MASK)
  out = out.replace(PATTERNS[4], (_m, flag: string, sep: string) => `${flag}${sep}${MASK}`)
  out = out.replace(PATTERNS[5], (_m, pre: string) => `${pre}${MASK}`)
  out = out.replace(PATTERNS[6], (_m, name: string, sep: string) => `${name}${sep}${MASK}`)
  return out
}

/** Redacts every element; arrays of command arguments are redacted by position too. */
export function redactArgs(args: readonly string[], known: readonly string[] = []): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const prev = args[i - 1]?.toLowerCase()
    if (prev === '--token' || prev === '--pat' || prev === '--windowslogonpassword') { out.push(MASK); continue }
    out.push(redact(args[i], known))
  }
  return out
}
