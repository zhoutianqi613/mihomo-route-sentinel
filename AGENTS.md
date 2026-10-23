# Mihomo Route Sentinel

## Scope

- Build a reusable, dependency-free AI route quality sentinel and automatic failover service for Mihomo-compatible controllers.
- Support Windows Clash Verge named pipes and standard HTTP controllers.
- Keep runtime configuration in JSON and credentials only in environment variables.

## Constraints

- Require Node.js 20 or newer and use only built-in modules.
- Never read, persist, or log subscription URLs, node server addresses, controller secrets, tokens, or credentials.
- Probe real configured service targets and switch only after repeated failures and candidate validation.
- Prevent flapping through consecutive-failure thresholds, cooldowns, and minimum quality gates.
- Default to dry-run-safe behavior until the user explicitly runs continuous mode without `--dry-run`.

## Verification

- Run `npm test`.
- Run a dry-run one-shot check against the current Mihomo controller.
- Validate JSON configuration and confirm no secrets are present in tracked files.
