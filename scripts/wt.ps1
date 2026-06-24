#requires -Version 5.1
<#
.SYNOPSIS
  wt - one-git-worktree-per-session manager for parallel development.

.DESCRIPTION
  Enforces the "one session per worktree" rule so several Claude/Codex
  sessions (or humans) can develop in parallel WITHOUT corrupting the shared
  working tree. Each feature gets an isolated git worktree (its own HEAD and
  index) plus its own branch; integration into main happens later, once, via a
  single designated integrator session.

  A single `git checkout` directory has exactly ONE HEAD / index / refs db.
  Two writers in it -> corruption or yanked-out-from-under-you state. "Different
  branches in the same folder" is fake isolation: checkout / branch -D / rebase
  all mutate the shared refs. Real isolation = one worktree per session.

  Convention:
    branch  feat/<slug>     <->     worktree  <repo-parent>/wt-<slug>

  See docs/parallel-dev-worktree.md for the full protocol and the rationale.

.EXAMPLE
  ./scripts/wt.ps1 new auth-refresh    # spin up an isolated worktree + branch
  ./scripts/wt.ps1 list                # worktrees: branch, dirty, ahead/behind
  ./scripts/wt.ps1 status              # integration board (merged into main?)
  ./scripts/wt.ps1 rm auth-refresh -DeleteBranch   # tear down when merged
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1)][string]$Slug,
  [string]$Base = 'main',
  [switch]$Force,
  [switch]$DeleteBranch,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host $msg }
function Ok($msg)   { Write-Host $msg -ForegroundColor Green }
function Warn($msg) { Write-Host $msg -ForegroundColor Yellow }

# --- locate the shared repo + its main worktree (works from ANY worktree) ---
function Get-MainWorktree {
  $porcelain = & git worktree list --porcelain 2>$null
  if ($LASTEXITCODE -ne 0) { Fail "not inside a git repository" }
  foreach ($line in $porcelain) {
    if ($line -like 'worktree *') { return ($line -replace '^worktree ', '') }
  }
  Fail "could not determine the main worktree"
}

function Branch-Exists($name) {
  & git show-ref --verify --quiet "refs/heads/$name"
  return ($LASTEXITCODE -eq 0)
}

function Validate-Slug($s) {
  if ([string]::IsNullOrWhiteSpace($s)) { Fail "missing <slug>. Usage: wt <new|rm> <slug>" }
  if ($s -notmatch '^[a-z0-9][a-z0-9-]*$') {
    Fail "invalid slug '$s' (use lowercase letters, digits, hyphens; e.g. auth-refresh)"
  }
}

$Main   = Get-MainWorktree
$Parent = Split-Path $Main -Parent

function WorktreePath($slug) { return (Join-Path $Parent "wt-$slug") }
function BranchName($slug)   { return "feat/$slug" }

function Cmd-New {
  Validate-Slug $Slug
  $branch = BranchName $Slug
  $path   = WorktreePath $Slug
  if (Branch-Exists $branch) { Fail "branch '$branch' already exists; pick another slug or rm it first" }
  if (Test-Path $path)       { Fail "directory already exists: $path" }
  if (-not (Branch-Exists $Base)) {
    Warn "base '$Base' is not a local branch; git will try to resolve it as a commit-ish"
  }
  if ($DryRun) { Info "[dry-run] git -C `"$Main`" worktree add `"$path`" -b $branch $Base"; return }

  & git -C $Main worktree add $path -b $branch $Base
  if ($LASTEXITCODE -ne 0) { Fail "git worktree add failed (another session may hold a lock; retry)" }

  Ok ""
  Ok "Created isolated worktree:"
  Ok "  branch : $branch"
  Ok "  dir    : $path"
  Info ""
  Info "Next:"
  Info "  cd `"$path`""
  Info "  # edit + commit HERE only; this dir is yours alone"
  Info ""
  Warn "RED LINE: never run a second session against this dir, and never git-write"
  Warn "the same files from the main worktree at the same time."
  Info ""
  Info "When done:  ./scripts/wt.ps1 status   (then the integrator merges $branch -> main)"
}

function Get-WorktreeEntries {
  $porcelain = & git -C $Main worktree list --porcelain
  $entries = @()
  $cur = $null
  foreach ($line in $porcelain) {
    if ($line -like 'worktree *') {
      if ($cur) { $entries += $cur }
      $cur = [ordered]@{ path = ($line -replace '^worktree ', ''); branch = '' }
    }
    elseif ($line -like 'branch *') { $cur.branch = ($line -replace '^branch refs/heads/', '') }
    elseif ($line -eq 'detached')   { $cur.branch = '(detached)' }
  }
  if ($cur) { $entries += $cur }
  return $entries
}

function Cmd-List {
  Info "Worktrees  (path | branch | state | ahead/behind main):"
  foreach ($e in (Get-WorktreeEntries)) {
    $state = 'MISSING'
    if (Test-Path $e.path) {
      $st = & git -C $e.path status --porcelain
      if ($st) { $state = 'DIRTY' } else { $state = 'clean' }
    }
    $ab = ''
    if ($e.branch -and $e.branch -ne '(detached)' -and $e.branch -ne 'main') {
      $rl = & git -C $Main rev-list --left-right --count "main...$($e.branch)" 2>$null
      if ($LASTEXITCODE -eq 0 -and $rl) {
        $p = ($rl.Trim() -split '\s+')
        $ab = "+$($p[1]) ahead / -$($p[0]) behind"
      }
    }
    Write-Host ("  {0,-44} {1,-32} {2,-8} {3}" -f $e.path, $e.branch, $state, $ab)
  }
}

function Cmd-Status {
  Info "Integration board  (local branches vs main):"
  $merged = & git -C $Main branch --merged main --format '%(refname:short)'
  $all    = & git -C $Main branch --format '%(refname:short)'
  $wt = @{}
  foreach ($e in (Get-WorktreeEntries)) { if ($e.branch) { $wt[$e.branch] = $true } }

  foreach ($b in $all) {
    if ($b -eq 'main' -or [string]::IsNullOrWhiteSpace($b)) { continue }
    $tag    = if ($merged -contains $b) { '[merged]  ' } else { '[UNMERGED]' }
    $hasWt  = if ($wt.ContainsKey($b)) { 'worktree-attached' } else { 'no worktree' }
    Write-Host ("  {0} {1,-40} {2}" -f $tag, $b, $hasWt)
  }
  Info ""
  Info "Integrator protocol: from ONE session on 'main', merge each [UNMERGED] feat/* one"
  # replace with your project's gates
  Info "at a time; after each, run gates (npm test; npm run typecheck; npm run lint) and"
  Info "stop on conflict to resolve it by hand. Do not auto-merge into main."
}

function Cmd-Rm {
  Validate-Slug $Slug
  $branch = BranchName $Slug
  $path   = WorktreePath $Slug

  if (Test-Path $path) {
    $st = & git -C $path status --porcelain
    if ($st -and -not $Force) {
      Fail "worktree '$path' has uncommitted changes; commit/stash first or pass -Force"
    }
    if ($DryRun) { Info "[dry-run] git -C `"$Main`" worktree remove $(if($Force){'--force '})`"$path`"" }
    else {
      if ($Force) { & git -C $Main worktree remove --force $path } else { & git -C $Main worktree remove $path }
      if ($LASTEXITCODE -ne 0) { Fail "worktree remove failed" }
      Ok "Removed worktree: $path"
    }
  }
  else { Warn "worktree dir not found: $path (maybe already removed)" }

  if ($DeleteBranch) {
    if (Branch-Exists $branch) {
      $merged = & git -C $Main branch --merged main --format '%(refname:short)'
      if (($merged -contains $branch) -or $Force) {
        if ($DryRun) { Info "[dry-run] git -C `"$Main`" branch -D $branch" }
        else { & git -C $Main branch -D $branch; Ok "Deleted branch: $branch" }
      }
      else { Warn "branch '$branch' is NOT merged into main; kept (pass -Force to override)" }
    }
    else { Warn "branch '$branch' not found" }
  }
  else { Info "Branch '$branch' kept. Pass -DeleteBranch to remove it (only when merged)." }
}

function Cmd-Help {
  $text = @"
wt - one-git-worktree-per-session manager for parallel development

  One session per worktree. Never two writers on the same checkout.
  Convention:  feat/<slug>  <->  <repo-parent>/wt-<slug>

USAGE
  wt.ps1 new <slug> [-Base main] [-DryRun]
      Create an isolated worktree on a new branch feat/<slug>, based on <Base>.
  wt.ps1 list
      Show every worktree with its branch, dirty state, and ahead/behind main.
  wt.ps1 status
      Integration board: which feat/* branches are merged into main yet.
  wt.ps1 rm <slug> [-Force] [-DeleteBranch]
      Tear down a worktree (must be clean unless -Force; -DeleteBranch only
      removes the branch when it is already merged into main, unless -Force).
  wt.ps1 help

See docs/parallel-dev-worktree.md for the full protocol and the rationale.
"@
  Write-Host $text
}

switch ($Command.ToLower()) {
  'new'    { Cmd-New }
  'list'   { Cmd-List }
  'ls'     { Cmd-List }
  'status' { Cmd-Status }
  'rm'     { Cmd-Rm }
  'remove' { Cmd-Rm }
  'help'   { Cmd-Help }
  '-h'     { Cmd-Help }
  '--help' { Cmd-Help }
  default  { Warn "unknown command: $Command"; Info ""; Cmd-Help; exit 1 }
}
