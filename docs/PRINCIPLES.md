# Principles

TokenScope is opinionated software. This page is the statement of intent — read
it before adopting, so you know exactly what you're getting and whether it fits.

## The paradigm: TokenSheets

> **Manage AI engineering the way you manage people engineering.**

People engineering has a mature operating model, and it works:

- A developer logs **time** (a timesheet).
- Time is **assigned to a project**.
- The project has a **budget** (hours / dollars).
- A **manager** watches the burn against completion, and when the work justifies
  it, **reviews and extends** the budget.

TokenScope applies the *same* model to AI developers:

- An AI developer emits **tokens** (a "TokenSheet").
- Tokens are **assigned to a project**.
- The project has a **token budget**.
- The *same* manager watches the *same* burn — and tops it up the *same* way.

A token is a unit of engineering effort. If a person's time bills to a project,
a person's tokens should too. Everything in TokenScope follows from that.

## The principles that guide the build

**1. A token has an owner, a claim, and a home.**
Every token attributes to a **teammate** (who), proposes a **project** (what it's
for), and — failing a project — lands on a named **cost-owning unit** (where the
cost lives). No token is anonymous; no cost is unhomed.

**2. Usage and billing are different questions — never conflate them.**
*Usage completeness* (§A, "what did this person actually consume?") and
*billing / chargeback* (§B, "what do we cross-charge?") are separate axes. A
usage view must never read below the provider's own truth; a charge is only ever
decided in one place. Showing usage is not the same as charging for it.

**3. Trust the developer; track every token; let the budget teach.**
TokenScope is not a lockdown. It governs by *financial gravity* — a base
allowance for exploration, real budgets for real work, and velocity/volume
limits that inform rather than block. The goal is a team that understands its own
consumption, not one that games a quota.

**4. Tag proposes, membership disposes.**
A project claim on a token is a *proposal*, gated by membership — not a
self-asserted fact. Untagged spend is retroactively assignable in one click, so
onboarding is "emit now, attribute later" and no developer is ever blocked by a
form.

**5. Zero-touch emission; unspoofable identity.**
Onboarding a developer should be a one-time, near-invisible step. The binding
between emitted telemetry and a real person is **server-minted and
unspoofable** — attribution you can put money behind.

**6. Reconcile against truth, don't infer it.**
Streaming telemetry is fast but incomplete; the provider's usage/billing API is
the truth. TokenScope runs both and reconciles, so completeness holds even for
people who never enrolled — and so a number on a screen is defensible.

**7. Fit over reach.**
TokenScope does one paradigm well. If the TokenSheets model is how you want to
run AI engineering, it should fit cleanly. If it isn't, don't bend it to fit —
it's honest about what it is, and there are other tools (and other things we
open-source) for other shapes.

## Who it's for

- **Developers** who want an honest "my usage" view they can trust.
- **Project / agile managers** who run budgets and burn-down, and decide when to
  extend.
- **Finance** who need a defensible chargeback at the grain the provider bills.
- **Cost-centre owners** who carry the P&L for their unit's AI spend.

If those roles map to how your organisation works, TokenScope is built for you.
