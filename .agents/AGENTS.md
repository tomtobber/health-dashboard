# AGENT CODING & ERROR HANDLING CONSTRAINTS
# Stack: TypeScript / Node.js
# These rules are non-negotiable. Violating them is a bug, not a style choice.

## 1. NO SILENT FAILURES
- Never `catch (e) {}` or `catch (e) { console.log(e) }` and move on. Every catch block
  must do one of: rethrow as a typed error, return a `Result<T, E>`-style object, or
  log with structured context AND propagate.
- Never return `null`, `undefined`, `false`, or `[]` to signal an error unless it is the
  explicit, documented function contract. Prefer throwing a typed error or returning a
  discriminated union (e.g. `{ ok: true, value } | { ok: false, error }`).

## 2. TYPED ERRORS ONLY & SERIALIZATION SAFETY
- No throwing bare `Error`. Define domain-specific error classes that extend a common
  `AppError` base (e.g. `ValidationError`, `ExternalServiceError`, `NotFoundError`).
- Every custom error must carry enough context to debug without reproducing locally
  (relevant IDs, operation name, upstream status code if applicable).
- Base `AppError` constructors MUST explicitly redefine `message` (and `name`) as
  enumerable via `Object.defineProperty(this, 'message', { value: message, enumerable: true, configurable: true, writable: true })`.
  Standard `Error.prototype.message` is non-enumerable in JS/V8 and is silently omitted
  by `JSON.stringify` unless made explicitly enumerable. Tests must assert on actual
  serialized JSON output (`JSON.parse(JSON.stringify(err))`).

## 3. INPUT VALIDATION AT BOUNDARIES
- Validate all external input (HTTP request bodies/params/query, env vars, file reads,
  third-party API responses) with a runtime schema validator (Zod). Do not trust types
  alone — TypeScript types vanish at runtime.
- Parse, don't just assert. Prefer `schema.parse(input)` over `input as MyType`.

## 4. ASYNC / NETWORK / I-O SAFETY
- Every `fetch`, DB call, or other I/O operation must have an explicit timeout
  (AbortController or an equivalent wrapper). No unbounded waits.
- No un-awaited promises and no missing `.catch()` — enable and respect
  `no-floating-promises` (see eslint config).
- When running multiple independent async operations, use `Promise.allSettled`
  unless a single failure should legitimately abort the whole batch.
- Add retry logic (with backoff) for transient external calls (network, third-party
  APIs) — but never retry on validation or auth errors.

## 5. BOUNDARY / NULLABILITY CHECKS
- No deep unguarded property access on external data (`res.data.user.id`). Validate
  the shape first (schema) or use optional chaining with an explicit fallback and a
  logged warning if the fallback path is taken.
- Explicitly handle empty arrays, empty strings, and zero as distinct from "missing."

## 6. STATE INTEGRITY
- Any multi-step mutation (multiple DB writes, multiple external calls that must both
  succeed) must be wrapped in a transaction, or have explicit compensating/rollback
  logic if a transaction isn't available across the operations involved.
- If an operation fails partway through, the code must leave the system in a state you
  can name and explain — never "undefined but probably fine."

## 7. RESOURCE CLEANUP
- Any opened file handle, DB connection, or lock must be closed/released in a
  `finally` block or via a `using`/context-manager-equivalent pattern, including on
  the error path.

## 8. LOGGING
- Every catch block and every "this shouldn't happen" branch logs with structured
  context (operation name, relevant IDs, error object) — not a bare string.
- No `console.log` for anything other than local scratch debugging; use the project
  logger.

## 9. TYPESCRIPT STRICTNESS
- `strict: true` in tsconfig is mandatory. Do not use `any` to silence a type error —
  fix the type or use `unknown` and narrow it.
- No `@ts-ignore` / `@ts-expect-error` without an inline comment explaining why and a
  linked issue if it's a workaround for a known limitation.

## 10. SELF-REVIEW BEFORE FINALIZING
Before presenting a diff as finished, check it against sections 1–9 above and against
`RECURRING_MISTAKES.md` in the repo root. List anything you find, fix it, then present
the revised diff — don't present the checklist results as a caveat instead of fixing
the code.

## 11. EXPLANATION VS. MODIFICATION ARE SEPARATE STEPS
- If the user asks to explain, investigate, diagnose, or understand why
  something happens, do NOT modify any files. Answer in prose only.
- Only make code changes when the user explicitly asks for a fix, change,
  or implementation — a question is not that, even if the answer reveals
  an obvious bug.
- If you believe something should be fixed while answering a question,
  say so explicitly and ask before touching any file.
