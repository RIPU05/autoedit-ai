# Antigravity Agent Guidelines — AutoAI Edit

These persistent rules govern all automated development, verification, git, pull request, and deployment workflows within the **AutoAI Edit** repository (`https://github.com/RIPU05/autoedit-ai`).

---

## 1. Automatic Git Operations

For every development, bugfix, enhancement, or documentation task completed by Antigravity:

1. **Review Modifications:** Review all changed and untracked files with `git status` and `git diff`.
2. **Execute Tests:** Run affected automated tests (e.g. `npm test` in `apps/api`) and ensure all pass without failure.
3. **Build Verification:** Run TypeScript compilation (`npm run build` in `apps/api`) and Next.js production build (`npm run build` in `apps/web`).
4. **Fix Regressions:** Fix any compile errors or test regressions introduced by changes before committing.
5. **Sanitize & Exclude:** Verify that no API keys, secrets, `.env` values, temporary files, or unrelated modifications are staged.
6. **Scoped Staging:** Stage only the specific files belonging to the current task using explicit `git add <files>` (avoid blanket `git add .`).
7. **Structured Commit:** Create a descriptive Git commit explaining the problem, the solution, and test coverage.
8. **Automatic Push:** Automatically push the completed feature branch to GitHub (`git push -u origin <branch-name>`).
9. **Verify Remote:** Confirm that the remote branch received the new commit using `git ls-remote` or `git rev-parse`.
10. **Automatic Pull Request:** Automatically check for an open Pull Request for the branch; create a new PR via GitHub CLI (`gh pr create`) or update the existing PR (`gh pr edit`), targeting the appropriate base branch determined by Git ancestry and architecture governance.

> [!NOTE]
> Do not pause or request user input simply to execute a routine `git push` or create a routine Pull Request on a development/feature branch.

---

## 2. GitHub Authentication & Security

- **Authentication Method:** Use the persistent Git Credential Manager (`credential.helper=manager`) configured on the host machine.
- **CLI Authentication:** Use GitHub CLI (`gh`) authenticated under the account `RIPU05` (the owner of `RIPU05/autoedit-ai`). If `gh` is not in the active subshell PATH, invoke it via its standard installation path (`C:\Program Files\GitHub CLI\gh.exe`) or refresh the session PATH from system/user environment variables.
- **Account Identity:** The authenticated GitHub account must always be `RIPU05`.
- **Secret Zero-Tolerance:** Never store GitHub tokens, personal access tokens (PATs), API keys, or database credentials in source code, `.env` files, logs, artifacts, or Git commits.
- **Interactive Requests:** If credentials ever expire or require interactive re-authentication, halt the operation immediately, report the exact error, and request that the user authenticate once in an interactive terminal.
- **No Bypass:** Never attempt to bypass access controls or authentication checks.

---

## 3. Safe Branch Strategy & Ancestry Selection

- **Feature Isolation:** All routine work, experiments, bugfixes, and documentation updates must occur on a dedicated, isolated branch (`feature/<name>`, `fix/<name>`, or `docs/<name>`).
- **Master Branch Protection:** Never push directly to `master` during routine development.
- **Correct Base Branch Selection:**
  - Never assume `master` is the appropriate destination for a PR.
  - **Documentation changes** must target the approved documentation baseline (`docs/autoai-master-blueprint` or its direct upstream parent in the stacked documentation lineage).
  - **Implementation changes** must target the approved integration or milestone branch (e.g. `stage2-integration` or Milestone baseline).
  - Always inspect Git ancestry (`git merge-base`, `git log`) to verify the correct base branch before opening a PR.
- **Branch Purity & Conflict Prevention:**
  - Never include unrelated experimental branches in a PR.
  - Inspect diffs and commit logs before opening any PR.
  - If a PR would introduce unintended changes, stale snapshots, or duplicate commits, **stop and report the issue to the user instead of creating an invalid PR**.
- **Preserve History & Working Tree:**
  - Never use `--force` or `--force-with-lease` on shared, release, or baseline branches.
  - Never reset or rebase shared commits.
  - Never delete remote branches automatically.
  - Untracked markdown reports, persistent project notes, or files unrelated to the task must be preserved and never discarded.

---

## 4. Automatic Pull Request Workflow

Antigravity automatically manages the complete PR lifecycle for routine development and documentation tasks:

### 4.1 PR Creation & Update Rules
1. **Check Existing PRs:** Query GitHub via `gh pr list --head <branch-name> --state open`.
2. **Update Existing PR:** If an open PR already exists for the head branch, update its title, body, or base branch as needed using `gh pr edit`.
3. **Create New PR:** If no open PR exists, create one automatically using:
   ```powershell
   gh pr create --base <target-base> --head <feature-branch> --title "<descriptive title>" --body "<structured body>"
   ```
4. **Structured PR Description:** Every PR body must include:
   - **Summary of Changes:** What was added, fixed, or updated.
   - **Architectural Reference:** Traceability to feature IDs or architecture documents.
   - **Test & Build Verification:** Test outcomes and compilation results.
   - **Branch Ancestry & Base:** Target base branch justification.
5. **Report URLs:** Return clickable GitHub PR URLs in the standard completion report.

### 4.2 Non-Negotiable Approval & Merge Rules
- **Automatic Creation & Update ONLY:** The agent is authorized to CREATE and UPDATE Pull Requests automatically.
- **Strictly Prohibited — Auto-Merging:** **NEVER** merge a Pull Request automatically. Never run `gh pr merge` without prior explicit human approval.
- **Strictly Prohibited — Enabling Auto-Merge:** **NEVER** enable GitHub auto-merge (`gh pr merge --auto` is forbidden).
- **Strictly Prohibited — Production Deployments:** **NEVER** trigger production deployment or apply database migrations automatically via PR actions.
- **Human Gate:** All Pull Requests remain open pending explicit review and approval by the repository owner (`RIPU05`).

---

## 5. Production Deployment Rules

- **Connected Platforms:**
  - **Frontend:** Vercel (`https://autoedit-ai.vercel.app/`)
  - **Backend:** Render (`https://autoedit-ai.onrender.com/`)
- **Master Deployment Gate:** Both Vercel and Render automatically build and deploy whenever commits are pushed to `master`.
- **Approval Gate:** Merging into `master` or pushing to `master` is **strictly prohibited without prior explicit user approval**.
- **Production Release Flow:**
  1. Present the 8-point Deployment Approval Gate (files, builds, affected services, downtime/risk, rollback, migrations, smoke checklist).
  2. Stop and wait for explicit user approval.
  3. Only upon receiving approval: merge the feature branch into `master`, push to `origin master`, monitor builds, and execute production smoke tests.

---

## 6. Quality Gates

Never automatically push code to GitHub or create a PR if any of the following apply:
- Critical automated unit or integration tests fail.
- `apps/api` TypeScript compilation fails or `apps/web` Next.js build fails.
- A security vulnerability, authorization bypass, or secret leak is detected.
- Unrelated files, temporary files, or binary artifacts are staged.
- The remote branch has diverged unexpectedly.

When a quality gate fails, stop the push and PR creation, diagnose the root cause, fix it if within scope, or report the blocker to the user.

---

## 7. Standard Task Completion Report

After completing any development, documentation, or workflow task, provide a concise summary using this format:

- **Task Completed:** Brief description of what was implemented or fixed.
- **Files Modified:** List of all changed or created files.
- **Test Results:** Number of passing, failing, and skipped tests.
- **Build Status:** Results of API and Web builds.
- **Branch:** Name of the feature branch.
- **Commit Hash:** Short commit hash.
- **GitHub Push Status:** Verification that the commit exists on `origin/<branch>`.
- **GitHub URL:** Direct URL to the commit or branch on GitHub (`https://github.com/RIPU05/autoedit-ai/commit/<hash>`).
- **Pull Request:** Direct URL to the created or updated PR (`https://github.com/RIPU05/autoedit-ai/pull/<number>`), target base branch, and status.
- **PR Checks / Review Status:** State of the PR and pending human approvals.
- **Production Status:** "Not deployed (Feature branch)" or "Deployed to production (if approved master release)".
- **Remaining Issues / Notes:** Any follow-up items or recommendations.
