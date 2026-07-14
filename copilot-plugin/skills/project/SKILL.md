---
description: Bind this repository to a TokenScope project budget by writing a .tokenscope file at the repo root
argument-hint: '[project code or search text]'
---

# tokenscope-project — Bind This Repo to a Budget

Tag the current repository to a TokenScope **project budget** by writing a
committed `.tokenscope` file at the repo root.

## When to Use

- Setting up a repo so its Copilot CLI sessions attribute to the right budget.
- Re-pointing a repo to a different budget.
- You don't know the exact project code and want to pick from a list.

## Workflow

### Step 1: List your budgets

Call **`list_my_projects`** — the budgets you are a current member of. Each has an
`id`, `code`, and `display_name`. The value written to `.tokenscope` is the project
**`code`** (the stable slug), not the UUID.

### Step 2: Present and let the user pick

Show the budgets as a short numbered list (code + display name). Ask which budget
this repository's work should bill to.

If a project code or search text was passed as the skill argument, match it against
the listed budgets first (by `code` or `display_name`) and confirm rather than
guessing.

### Step 3 (optional): Confirm the code resolves

You may call **`resolve_repo_project`** with the chosen `code` to confirm it maps
to a budget you are a member of and echo back its `display_name` and `type`. If it
reports the code is not a member project, do not write the file; re-pick from
`list_my_projects`.

### Step 4: Write `.tokenscope`

Write a file named exactly `.tokenscope` at the **repository root**. It MUST be the
YAML `project:` block below, with the chosen project code on an indented `code:`
line — copy this shape exactly, substituting the code:

```
# TokenScope — commit this so the project tag travels with the repo.
project:
  code: <project code>
```

For example, for the code `TokenScope-MVP`:

```
# TokenScope — commit this so the project tag travels with the repo.
project:
  code: TokenScope-MVP
```

Use your own file-writing tool — the MCP server never writes the user's disk. The
indented `project:` / `  code:` form is required: the forwarder's reader takes the
code ONLY from an indented `code:` line under `project:`. A bare one-line file
(just the code) parses to **no** project code and the repo lands **untagged** — and
worse, a Claude Code repo with the same one-liner would derive a different result,
splitting the budget across clients. Keep the YAML form so both clients agree.

If a `.tokenscope` already exists with a different code, show the old and new values
and confirm before overwriting.

### Step 5: Confirm and advise committing

Tell the user:

- The repo is now bound to budget **{code}** ({display_name}).
- **Commit `.tokenscope`** so teammates attribute to the same budget — it holds
  only a non-secret project code.
- The TokenScope forwarder reads this committed `.tokenscope` and tags this repo's
  Copilot spend to the budget automatically. Tagging applies to the **next** Copilot
  session started in this repo (the forwarder reads the file on session start).
- One repo per host: the forwarder is a single shared process and tags from the repo
  it was started in. If you run Copilot in **two different repos on the same host at
  once**, it will not tag either (it refuses to mis-attribute) — run them on separate
  hosts, or tag those sessions explicitly with `tag_session`.
