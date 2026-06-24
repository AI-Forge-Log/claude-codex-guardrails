# Parallel development: one session per git worktree

The rationale companion to [`scripts/wt.ps1`](../scripts/wt.ps1). Read this once;
then let the script enforce the convention for you.

When several Claude/Codex sessions (or humans) develop in parallel, the failure
mode is not merge conflicts — git handles those. The failure mode is **two
writers sharing one working tree**, which corrupts state that git assumes is
owned by exactly one process. This doc explains why, what real isolation looks
like, and the protocol that keeps it safe.

## 1. Why a single checkout can hold only one writer

A single `git checkout` directory has exactly **one HEAD, one index, and one
refs database**. Those are shared, mutable state:

- **HEAD** — the commit/branch you are currently on. There is one of it.
- **The index** (staging area) — a single file (`.git/index`) recording what
  the next commit will contain.
- **Refs** — `refs/heads/*` and friends, the pointers your branches resolve to.

Two sessions writing into the same checkout at the same time race on this shared
state. Concretely:

- Session A runs `git add`/`git commit`; session B runs `git add` a heartbeat
  later. Both write `.git/index`. One overwrites the other, or you get a
  partially staged, inconsistent index.
- Session A runs `git checkout other-branch`. It rewrites HEAD and rewrites the
  files in the working directory. Session B, still editing what it thought was
  its branch, is now sitting on top of a different tree it never asked for —
  edits land against the wrong base, or get clobbered on the next checkout.
- Session A runs `git rebase` or `git reset`; the refs and HEAD move under
  session B mid-operation.

The result is not a clean conflict you resolve later — it is a corrupted or
yanked-out-from-under-you working state that is hard to even diagnose.

## 2. Fake isolation vs. real isolation

> "We're on different branches in the same folder, so we won't collide."

This is **fake isolation**. "Different branch, same directory" still shares the
one HEAD, the one index, and the one refs database described above. The
operations you use to move between branches all mutate that shared state:

- `git checkout <branch>` — rewrites HEAD and the working tree.
- `git branch -D <branch>` — mutates refs.
- `git rebase` / `git reset` — rewrite refs and HEAD.

So two sessions in the same folder collide the instant either one switches,
deletes, or rebases a branch — even though they are "on different branches."

**Real isolation = one git worktree per session.** A worktree is a *separate
working directory* with its **own HEAD and its own index**, while safely sharing
the single underlying object store (the commits and blobs in `.git`). Two
worktrees can be on two branches simultaneously without ever fighting over HEAD
or the index, because each has its own. That is the property `wt.ps1` gives you.

## 3. Convention

`wt.ps1` ties one branch to one sibling directory, deterministically:

```
branch  feat/<slug>     <->     worktree  <repo-parent>/wt-<slug>
```

- `<slug>` is lowercase letters, digits, and hyphens (e.g. `auth-refresh`).
- The worktree directory is created **next to the repo** (its parent folder),
  named `wt-<slug>` — never nested inside the main checkout.
- The branch is always `feat/<slug>`, branched from `main` by default.

This mapping is the contract: given a slug you always know the branch and the
directory, and vice versa. The script computes both for you, so you never type
either path by hand.

## 4. Commands

All commands are run from inside the repo (any worktree works — the script
locates the main worktree itself). Examples use Windows PowerShell.

| Command | What it does |
| --- | --- |
| `new <slug>` | Create an isolated worktree on a new branch `feat/<slug>`, based on `-Base` (default `main`). |
| `list` (alias `ls`) | List every worktree with its branch, dirty/clean state, and ahead/behind `main`. |
| `status` | Integration board: which `feat/*` branches are merged into `main` yet, and whether a worktree is still attached. |
| `rm <slug>` | Tear down a worktree. Refuses if it has uncommitted changes unless `-Force`. With `-DeleteBranch`, also deletes the branch — but only when it is already merged into `main`, unless `-Force`. |
| `help` | Print usage. |

Flags: `-Base <branch>` (base for `new`, default `main`), `-Force`,
`-DeleteBranch`, `-DryRun` (print the git commands without running them).

Examples:

```powershell
# Spin up an isolated worktree + branch for one feature
./scripts/wt.ps1 new <slug>

# Branch from something other than main
./scripts/wt.ps1 new <slug> -Base release-2

# Preview without touching anything
./scripts/wt.ps1 new <slug> -DryRun

# See who is working where, and the integration state
./scripts/wt.ps1 list
./scripts/wt.ps1 status

# Tear down once the branch is merged into main
./scripts/wt.ps1 rm <slug> -DeleteBranch
```

After `new`, work **only** inside the printed `wt-<slug>` directory — edit and
commit there, and nowhere else. The red line: never point a second session at
that directory, and never git-write the same files from the main worktree at the
same time.

## 5. Integrator protocol

Creating work in parallel is safe; **merging it is not parallel work**. All
integration funnels through a single session for correctness:

1. **One integrator, on `main`.** Merges happen from a single session sitting on
   the `main` branch (the main worktree). No other session merges concurrently.
2. **One `feat/*` branch at a time.** Use `wt.ps1 status` to see the `[UNMERGED]`
   branches, then merge them one by one — never a batch.
3. **Gates after every merge.** After each merge, run the project's gates (tests,
   typecheck, lint — whatever the project defines) before merging the next
   branch. A merge that breaks the gates is reverted or fixed before continuing.
4. **Resolve conflicts by hand. Never auto-merge.** If a merge conflicts, stop
   and resolve it deliberately. Do not let any tool auto-resolve into `main`.
5. **Tear down when merged.** Once a branch is in `main` and its gates are green,
   remove the worktree and branch with `wt.ps1 rm <slug> -DeleteBranch` (the
   script will refuse to delete an unmerged branch unless you force it).

This keeps `main` linear and trustworthy: every commit on it passed the gates at
the moment it landed, and exactly one writer ever touched it at a time.
