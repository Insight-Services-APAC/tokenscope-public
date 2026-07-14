# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use **GitHub's private vulnerability reporting** on this repository
(the **Security** tab → *Report a vulnerability*). This routes the report
privately to the maintainers.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if you have one),
- affected version / commit, and
- any suggested remediation.

We aim to acknowledge reports within a few business days and will keep you
updated on remediation and disclosure timing. We ask that you give us reasonable
time to fix an issue before any public disclosure.

## Scope

This policy covers the TokenScope application, its deployment tooling
(`infra/`), and the emission plugins (`plugin/`, `copilot-plugin/`).

## Handling secrets and data

TokenScope is designed so that **no secret or real configuration lives in the
repository** — credentials come from environment variables / Key Vault at
runtime, and real usage data lives only in your own datastore. If you believe a
secret or real identifier has been committed, treat it as a vulnerability and
report it privately as above.
