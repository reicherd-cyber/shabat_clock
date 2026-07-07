# Security Policy

## Reporting a vulnerability

Please **do not** open public issues for security problems. Instead, report
privately via GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(Security tab → "Report a vulnerability"), or email the maintainer.

We aim to acknowledge reports within a few business days.

## Scope and sensitive surfaces

This service controls **physical relays** and is reachable through several
channels. Treat the following as security-critical:

- **Secrets** — `JWT_SECRET`, `IVR_TOKEN`, `MQTT_SERVER_PASS`, `DATABASE_URL`.
  Never commit real values; `.env` is gitignored. Generate with
  `openssl rand -base64 32`. Rotate on suspected exposure.
- **IVR endpoint** (`/ivr`) — gated by `IVR_TOKEN`; rate-limited.
- **Auth endpoints** (`/api/v1/auth/*`, `/api/v1/admin/auth/login`) — rate-limited.
- **MQTT** — use `mqtts://` (TLS) in production.
- **Database** — use a least-privilege user and TLS in production.

## Handling secrets

- Store production secrets in the host's secret manager / environment, never in git.
- In production the app refuses to start with weak or placeholder secrets.
- Enable GitHub secret scanning + push protection and Dependabot on this repo.
