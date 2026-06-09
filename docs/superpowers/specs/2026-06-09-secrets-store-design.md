# Secrets Store — Design

**Date:** 2026-06-09
**Status:** Approved

## Overview

A way to store secrets/API keys at both a global and project level, encrypted at rest, that Claude Code sessions inside Cross AI Browser terminals can access. Secrets are injected as environment variables when a terminal PTY spawns. The Electron app itself can also read secrets for future features. Secrets are local-only and never sync to Firebase.

## Decisions Made

| Question | Decision |
|---|---|
| Consumers | Claude Code in app terminal tabs + the Electron app itself |
| Delivery | Environment variables injected at PTY spawn |
| Management UI | New Secrets section in the prompt-library panel |
| Sync | Local-only; completely excluded from Firebase sync |
| Storage | Per-scope files encrypted with Electron `safeStorage` (Approach A) |

## Storage & Data Model

New directory: `~/Library/Application Support/Cross AI Browser/secrets/`

- `global.enc` — global secrets
- `<cwd-hash>.enc` — project secrets, reusing the same cwd-hash function the prompt library uses

Each file is the output of `safeStorage.encryptString()` applied to a JSON document:

```json
{
  "version": 1,
  "secrets": [
    {
      "id": "uuid",
      "name": "OPENAI_API_KEY",
      "value": "sk-...",
      "note": "optional free text",
      "enabled": true,
      "createdAt": 1780000000000,
      "updatedAt": 1780000000000
    }
  ]
}
```

Rules:

- `name` must match `[A-Za-z_][A-Za-z0-9_]*` (env-var format). Uppercase is convention, not enforced.
- `name` is unique within a scope (case-sensitive match).
- `value` is capped at 32 KB.
- `enabled: false` keeps a secret stored without injecting it.
- If `safeStorage.isEncryptionAvailable()` returns false, all saves are refused with a visible error. There is no plaintext fallback.

## Core Module: `src/core/SecretsManager.js`

Modeled on `PromptLibraryManager` + `PromptStorageEngine`. Owns all file I/O with atomic writes (write temp file, rename into place).

API:

- `list(scope, cwd)` → array of metadata only: `{ id, name, note, enabled, createdAt, updatedAt, scope }`. **Never returns values.**
- `reveal(scope, cwd, id)` → the decrypted value, only on explicit request.
- `create(scope, cwd, { name, value, note, enabled })`
- `update(scope, cwd, id, updates)`
- `delete(scope, cwd, id)`

All mutating calls take `(scope, cwd)` so the manager knows which store file to load — same convention as the prompt library, where the terminal's cwd comes from the IPC handler via `terminalId`.
- `getMergedEnv(cwd)` → `{ NAME: value, ... }` of all *enabled* secrets; project secrets override global secrets on name collision. This is also the entry point for the Electron app's own consumption (main process calls it or `reveal()` directly).

## Terminal Injection

In `ViewManager`'s PTY spawn path (after the PATH setup, currently `ViewManager.js:829`, before `pty.spawn` at line 833):

```js
Object.assign(env, this.secretsManager.getMergedEnv(cwd));
```

- Applies to **new terminals only**; running tabs keep their existing env.
- After any secret change, the panel shows a hint: "applies to new terminal sessions."
- If decryption fails at spawn time, log a warning and spawn the terminal **without** secrets — never block terminal launch.

## Library Panel UI

A new collapsible **Secrets** section in the prompt-library panel (below Notes), using the existing Global/Project scope treatment.

Each row: name, masked value (`••••••••`), and actions — reveal (eye toggle), copy, edit, delete.

Add/edit uses the inline editor pattern with fields: name, value, scope (Global/Project), note, enabled toggle.

Deliberate exclusions:

- Secrets are **not draggable** to the terminal.
- Search matches secret **names only**, never values.
- No lifecycle states (Done/Testing), no labels, no favorites, no images.
- All colors via design tokens (CSS variables with fallbacks); DOM built with `createElement`/`textContent` — no innerHTML.

## IPC Surface

New `ipcMain.handle` handlers in `main.js`, following the `prompt-library-*` pattern, exposed only through `terminal-preload.js`:

- `secrets-list` — metadata only, never values
- `secrets-create`
- `secrets-update`
- `secrets-delete`
- `secrets-reveal` — the only channel that returns a value, called by the eye/copy buttons

Load-bearing rule: the renderer never receives secret values except via an explicit `secrets-reveal` call.

## Security Guardrails

- Encryption key lives in the user's login Keychain (via `safeStorage`); never on disk.
- The `secrets/` directory is completely outside `FirebaseSyncAdapter`'s scope — nothing syncs.
- Secret values are never written to logs.
- Input validation: env-var name regex, 32 KB value cap.
- No plaintext fallback when encryption is unavailable.

**Accepted limitation (inherent to env-var delivery):** anything injected into a terminal's environment is readable by Claude Code and all child processes of that session. Encryption protects secrets *at rest*, not from the sessions they're injected into. Per-secret access prompts and audit logging were considered and rejected (YAGNI — they add no real protection under this delivery model).

## Error Handling

- Corrupt or undecryptable store file → renamed to `<file>.corrupt` as a backup, fresh store started, console warning logged.
- `safeStorage` unavailable → Secrets section disabled in the UI with an explanatory message.
- Decrypt failure at terminal spawn → warn and spawn without secrets.

## Verification Plan

1. Add a global secret and a project secret with the same name but different values.
2. Spawn a terminal in the project's cwd; `echo $NAME` shows the **project** value (override works).
3. Spawn a terminal in another cwd; `echo $NAME` shows the **global** value.
4. Disable a secret; new terminal does not have it.
5. Inspect `secrets/*.enc` on disk — confirm not plaintext.
6. Confirm an already-running terminal is unaffected by edits until restarted.
7. Confirm Firebase sync logs show no reads/writes of the secrets directory.

## Approaches Considered

- **A (chosen):** Per-scope files encrypted via `safeStorage` — follows the codebase's existing patterns (safeStorage for Firebase credentials, cwd-hash scoping for prompts/history); zero new dependencies.
- **B (rejected):** Direct macOS Keychain items — keytar unmaintained, `security` CLI clunky, fragile naming conventions for project scoping.
- **C (rejected):** Encrypted blob in electron-store — jams all scopes into one settings file; doesn't match per-cwd file scoping used elsewhere.
