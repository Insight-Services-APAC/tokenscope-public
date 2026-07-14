---
description: Show your month-to-date Copilot CLI token spend split by project budget, unallocated, and activity
---

# tokenscope-usage — Show Your Month-to-Date Usage

Show current-month TokenScope usage, split per budget, plus unallocated and
tagged (off-budget, categorised) spend. Covers Copilot CLI and any other AI tool
attributed to TokenScope.

## When to Use

- A quick read on where your Copilot CLI spend went this month.
- See how much is unallocated (and needs tagging).
- A breakdown by project and activity.

## Workflow

### Step 1: Fetch usage

Call the **`my_usage`** tool. It returns this shape:

```json
{
  "month_to_date": "2026-06",
  "total_cost_usd": "12.47",
  "total_tokens": 48200000,
  "total_allocation_usd": "50.00",
  "base_allowance_usd": "20.00",
  "total_quota_usd": "70.00",
  "buckets": [
    {
      "project_code": "AFL-AII",
      "display_name": "AFL · AI Insights",
      "cost_usd": "9.11",
      "tokens": 32400000,
      "allocation_total_usd": "50.00",
      "is_active_now": true,
      "source": "assigned",
      "ended": false
    }
  ],
  "unallocated": {
    "total_cost_usd": "3.36",
    "tagged_cost_usd": "2.10",
    "untagged_cost_usd": "1.26",
    "needs_tagging_count": 3,
    "soft_cap_usd": "20.00",
    "over_soft_cap": false
  },
  "tagged_spend": [
    { "activity": "code review", "cost_usd": "2.10", "tokens": 12000000, "sessions": 2 }
  ],
  "freshness_minutes_ago": 3,
  "note": "Updated from attribution_record."
}
```

### Step 2: Render three sections

**1. Budgeted (project) spend** — a markdown table from `buckets`:

```
| Project | Cost (USD) | Tokens | % of total |
|---------|-----------:|-------:|-----------:|
```

Sort by `cost_usd` desc; `% of total` is against `total_cost_usd`. Flag any
bucket whose `ended` is true as **(ended)** next to its name.

**2. Unallocated** — from `unallocated`: one line
`Unallocated: <total_cost_usd> / soft cap <soft_cap_usd>` and flag **OVER** when
`over_soft_cap` is true; then
`tagged <tagged_cost_usd> · untagged <untagged_cost_usd> · <needs_tagging_count> need tagging`.
Omit the section if `total_cost_usd` is `0.00`.

**3. Tagged spend** (categorised by activity, off-budget) — a table from
`tagged_spend`, sorted by cost desc; skip if empty:

```
| Activity | Cost (USD) | Sessions |
|----------|-----------:|---------:|
```

### Step 3: Footer + nudges

Footer line: `Updated <freshness_minutes_ago> min ago`.

> **Note:** Copilot CLI spend is **indicative** (telemetry-only) in v1 — priced
> from emitted AI-credit value (1 credit = $0.01 USD), not yet reconciled against
> GitHub billing. Expect a match within a few percent.

If `needs_tagging_count > 0`, nudge the user to tag those sessions
(`tag_session` MCP tool for a specific session, `tokenscope-project` skill to bind
the repo, or in the web app). **This is the landed-but-UNBOUND signal**: that spend
emitted and landed but binds to **no project** (and, multi-org, no tenant) — landing
is not attribution. `unallocated.needs_tagging_count` is the same figure the
`tokenscope-status` skill reads to decide landed-AND-attributed vs landed-but-unbound;
a non-zero count means status is **not** healthy until those sessions are bound.

If `buckets` is empty: "No attribution data yet — sessions appear ~5 minutes after
they complete (OTLP ingest lag), and the repo must have a `.tokenscope` file for
spend to attribute to a project."

If `my_usage` reports an authentication error, run the `tokenscope-setup` skill to
connect.
