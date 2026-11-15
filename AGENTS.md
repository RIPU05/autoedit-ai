# Antigravity Agent Guidelines — AutoAI Edit

These persistent rules govern all automated development, verification, git, and deployment workflows within the **AutoAI Edit** repository (`https://github.com/RIPU05/autoedit-ai`).

---

## 1. Automatic Git Operations

For every development, bugfix, or enhancement task completed by Antigravity:

1. **Review Modifications:** Review all changed and untracked files with `git status` and `git diff`.
2. **Execute Tests:** Run affected automated tests (e.g. `npm test` in `apps/api`) and ensure all pass without failure.
3. **Build Verification:** Run TypeScript compilation (`npm run build` in `apps/api`) and Next.js production build (`npm run build` in `apps/web`).
4. **Fix Regressions:** Fix any compile errors or test regressions introduced by changes before committing.
5. **Sanitize & Exclude:** Verify that no API keys, secrets, `.env` values, temporary files, or unrelated modifications are staged.
6. **Scoped Staging:** Stage only the specific files belonging to the current task using explicit `git add <files>` (avoid blanket `git add .`).
7. **Structured Commit:** Create a descriptive Git commit explaining the problem, the solution, and test coverage.
8. **Automatic Push:** Automatically push the completed feature branch to GitHub (`git push -u origin <branch-name>`).
9. **Verify Remote:** Confirm that the remote branch received the new commit using `git ls-remote` or `git rev-parse`.

> [!NOTE]
> Do not pause or request user input simply to execute a routine `git push` on a development/feature branch.

---

## 2. GitHub Authentication & Security

- **Authentication Method:** Use the persistent Git Credential Manager (`credential.helper=manager`) configured on the host machine.
- **Account Identity:** The authenticated GitHub account must be `RIPU05` (the owner of `RIPU05/autoedit-ai`).
- **Secret Zero-Tolerance:** Never store GitHub tokens, personal access tokens (PATs), API keys, or database credentials in source code, `.env` files, logs, artifacts, or Git commits.
- **Interactive Requests:** If credentials ever expire or require interactive re-authentication, halt the push immediately, report the exact error, and request that the user authenticate once in an interactive terminal.
- **No Bypass:** Never attempt to bypass access controls or authentication checks.

---

## 3. Safe Branch Strategy

- **Feature Isolation:** All routine work, experiments, and bugfixes must occur on a dedicated feature or fix branch (`feature/<name>` or `fix/<name>`).
- **Master Branch Protection:** Never push directly to `master` during routine development.
- **Preserve History:** Never use `--force` or `--force-with-lease` on shared or release branches. Never reset shared commits.
- **Preserve Working Tree:** Untracked markdown reports, persistent project notes, or files unrelated to the task must be preserved and never discarded.

---

## 4. Production Deployment Rules

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

## 5. Quality Gates

Never automatically push code to GitHub if any of the following apply:
- Critical automated unit or integration tests fail.
- `apps/api` TypeScript compilation fails or `apps/web` Next.js build fails.
- A security vulnerability, authorization bypass, or secret leak is detected.
- Unrelated files, temporary files, or binary artifacts are staged.
- The remote branch has diverged unexpectedly.

When a quality gate fails, stop the push, diagnose the root cause, fix it if within scope, or report the blocker to the user.

---

## 6. Standard Task Completion Report

After completing any development task, provide a concise summary using this format:

- **Task Completed:** Brief description of what was implemented or fixed.
- **Files Modified:** List of all changed or created files.
- **Test Results:** Number of passing, failing, and skipped tests.
- **Build Status:** Results of API and Web builds.
- **Branch:** Name of the feature branch.
- **Commit Hash:** Short commit hash.
- **GitHub Push Status:** Verification that the commit exists on `origin/<branch>`.
- **GitHub URL:** Direct URL to the commit or branch on GitHub (`https://github.com/RIPU05/autoedit-ai/commit/<hash>`).
- **Production Status:** "Not deployed (Feature branch)" or "Deployed to production (if approved master release)".
- **Remaining Issues / Notes:** Any follow-up items or recommendations.
