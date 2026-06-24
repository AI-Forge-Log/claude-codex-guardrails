# claude-codex-guardrails

> Reliability glue for running Claude Code and Codex as a long-running dual-engine loop.
> 把 Claude Code 与 Codex 当成长跑式双引擎来跑的「可靠性胶水」。

*Keywords: claude code, codex, ai pair programming, review gate, git worktree, windows, hooks, claude-code-hooks, dual-engine.*

---

## What

Three small pieces of reliability glue for running **Claude Code (Opus)** and **Codex** as a long-running dual-engine loop:

1. **A quota-aware review gate** — [`hooks/review-gate-autosync.mjs`](hooks/review-gate-autosync.mjs). Keeps a "Codex reviews the diff before you can stop the session" gate in sync with your Codex quota, so a quota outage never traps you.
2. **A same-repo collision warden** — [`hooks/same-repo-warden.mjs`](hooks/same-repo-warden.mjs). Warns — without ever blocking — when another recent session is working in the same git repo.
3. **A one-session-per-worktree manager** — [`scripts/wt.ps1`](scripts/wt.ps1). Makes real git-worktree isolation a single command.

Plus [`tools/leakguard.mjs`](tools/leakguard.mjs), a zero-PII gate that fails the build on personal data (absolute paths, emails, a project-local denylist). It is what keeps this very repo clean.

For people who run Claude Code — especially in parallel, or with Codex as an adversarial reviewer — and want it to stay reliable across long sessions. No third-party dependencies: just Node built-ins, `git`, and PowerShell. Tested on Windows.

> **中文**
>
> 三块小小的「可靠性胶水」,用来把 **Claude Code(Opus)** 和 **Codex** 当成长跑式双引擎来跑:
>
> 1. **额度感知的复核闸** —— [`hooks/review-gate-autosync.mjs`](hooks/review-gate-autosync.mjs)。它把「会话停止前必须让 Codex 先复核 diff」这道闸,跟你的 Codex 额度自动同步,所以额度耗尽时绝不会把你困住。
> 2. **同仓撞车守卫** —— [`hooks/same-repo-warden.mjs`](hooks/same-repo-warden.mjs)。当另一个近期会话正在同一个 git 仓库里干活时,它只提醒、从不阻断。
> 3. **「一会话一 worktree」管理器** —— [`scripts/wt.ps1`](scripts/wt.ps1)。用一条命令完成真正的 git worktree 隔离。
>
> 另加 [`tools/leakguard.mjs`](tools/leakguard.mjs):一个「零个人信息」门禁,一旦发现个人数据(绝对路径、邮箱、项目本地的黑名单词)就让构建失败。本仓库的干净就是靠它守住的。
>
> 适合谁:跑 Claude Code 的人——尤其是并行跑、或把 Codex 当成对抗式审查员的人——并且希望它在长会话里一直可靠。无任何第三方依赖:只用 Node 内置模块、`git` 和 PowerShell。已在 Windows 上测试。

---

## The dual-engine loop in 60s

The loop is simple: **Claude (Opus) is the primary author; Codex is the adversarial reviewer.** You implement a change with Claude, then have Codex review the diff before the change counts as done. Two engines, two roles — a fresh reviewer with no authoring fatigue tends to catch what the author misses.

The **review gate** ties that discipline to your quota automatically: *you can't stop the session until Codex has reviewed* — but only while you actually have Codex quota. The day your quota runs out, the gate steps aside instead of locking you in.

Why split author and reviewer across two engines at all? See the dated model/benchmark comparison in [`docs/appendix-benchmarks-2026-06.md`](docs/appendix-benchmarks-2026-06.md) — it lays out where the two engines are complementary rather than interchangeable. **Caveat:** those numbers are directional, not independently verified (the "harness effect" alone can swing a score by tens of points).

> **中文**
>
> 这个循环很简单:**Claude(Opus)是主笔,Codex 是对抗式审查员。** 你用 Claude 实现一处改动,然后让 Codex 复核 diff,改动才算完成。两个引擎、两个角色——一个没有写作疲劳的新审查员,往往能抓到作者自己看漏的地方。
>
> **复核闸**把这条纪律和你的额度自动绑定:*会话必须等 Codex 复核完才能停*——但仅在你确实还有 Codex 额度时才生效。额度耗尽那天,闸会自己让开,而不是把你锁死。
>
> 为什么非要把「主笔」和「审查」拆到两个引擎上?见带日期的模型/基准对比 [`docs/appendix-benchmarks-2026-06.md`](docs/appendix-benchmarks-2026-06.md)——它讲清了两个引擎在哪些维度上是互补而非可互换的。**注意:** 那些数字只是方向性参考,未经独立验证(单单一个「harness effect」就能让分数摆动几十分)。

---

## Three failure modes

Each tool exists to defuse one concrete way a long dual-engine loop goes wrong.

| Failure mode | Symptom | The glue |
| --- | --- | --- |
| **Quota runs out** | A "review-before-stop" gate would block you from *ever* stopping the session. | [`review-gate-autosync`](hooks/review-gate-autosync.mjs) turns the gate **off** when Codex quota is exhausted and back **on** when it recovers. Fail-safe; it never traps you. |
| **Two sessions, one repo** | Concurrent writers corrupt shared git state (index / HEAD / branch refs). | [`same-repo-warden`](hooks/same-repo-warden.mjs) **warns** you about the other session. Fail-open; advisory only, never blocks. Wire it via [`examples/settings.snippet.json`](examples/settings.snippet.json). |
| **Fake isolation** | "Same directory, different branch" feels isolated but still corrupts the shared HEAD/index/refs. | [`wt.ps1`](scripts/wt.ps1) gives you **one git worktree per session** — real isolation in one command. See [`docs/parallel-dev-worktree.md`](docs/parallel-dev-worktree.md). |

> **中文**
>
> 每个工具都对应着「长跑式双引擎」会出岔子的一个具体场景。
>
> | 失效场景 | 症状 | 对应胶水 |
> | --- | --- | --- |
> | **额度耗尽** | 「停止前必须复核」的闸会让你**永远停不下来**。 | [`review-gate-autosync`](hooks/review-gate-autosync.mjs) 在 Codex 额度耗尽时把闸**关掉**,恢复后再**打开**。fail-safe,绝不困住你。 |
> | **两个会话,一个仓库** | 并发写入会腐蚀共享的 git 状态(index / HEAD / 分支 refs)。 | [`same-repo-warden`](hooks/same-repo-warden.mjs) 会就那个会话**提醒**你。fail-open,仅作提示、从不阻断。通过 [`examples/settings.snippet.json`](examples/settings.snippet.json) 接入。 |
> | **假隔离** | 「同目录、不同分支」看着像隔离,其实仍会腐蚀共享的 HEAD/index/refs。 | [`wt.ps1`](scripts/wt.ps1) 给你**一会话一个 git worktree**——一条命令实现真隔离。见 [`docs/parallel-dev-worktree.md`](docs/parallel-dev-worktree.md)。 |

---

## Design principles

### English
These three pieces share one rule: **a guardrail must never leave you worse off than if it weren't installed.** Four judgments follow from that.

**1. Fail-safe vs fail-open — fail toward whichever side can't hurt you.** When a hook can't be sure (it can't read the quota, the payload won't parse, the directory isn't a git repo), it must pick a safe default — and "safe" differs by tool:
- The review gate is **fail-safe**: if it can't read your Codex quota, it assumes *no* quota and turns the gate **off**. A gate stuck *on* with no quota would trap you — unable to even stop your session — so on doubt it never traps you.
- The same-repo warden is **fail-open**: any uncertainty → it stays silent and exits 0. It is only advisory; wrongly blocking an edit (you can't work) costs far more than a missed warning (at worst a recoverable git clash).
- How to choose: weigh the cost of a false block against the cost of a miss, and fail *away* from the larger one.

**2. Never block — advise, never veto.** Neither hook ever returns a block/deny decision. Hooks run on *every* session start/stop/edit, so a hook that *can* block becomes a single point that can brick your whole workflow the day it has a bug. They only emit advisory messages or quietly adjust state. The cost is giving up enforcement; the payoff is that a broken hook can never lock you out.

**3. Atomic writes — write a temp file, then rename.** The gate's state lives in a small `state.json`. Writing it in place risks a half-written, corrupt file if the process dies or another reader arrives mid-write — and that file controls the gate. Instead it writes a temp file and `rename`s it over the target; rename is atomic at the OS level, so a reader always sees either the complete old file or the complete new one, never a torn state.

**4. Real vs fake isolation.** "Same directory, different branch" feels isolated but isn't: `checkout`, `branch -D`, and `rebase` all mutate the one shared HEAD/index/refs, so two sessions in one checkout still corrupt each other. Real isolation is **one git worktree per session** — its own working directory, HEAD, and index, sharing only the (safe, read-mostly) object store. `wt.ps1` makes that the default in a single command.

### 中文
这三块共享一条规矩:**护栏绝不能让你比没装它时更糟。** 由此引出四个判断。

**1. fail-safe 还是 fail-open——往"不会害到你"的那边倒。** 当钩子拿不准时(读不到额度、负载解析失败、目录不是 git 仓库),它必须选一个安全默认值,而"安全"因工具而异:
- 复核闸是 **fail-safe**:读不到 Codex 额度,就当成没额度、把闸**关掉**。闸卡在"开"而又没额度会把你困住——连会话都停不了——所以拿不准时它绝不困住你。
- 撞车守卫是 **fail-open**:有任何不确定就闭嘴、退出 0。它只是个提醒;误拦一次编辑(你干不了活)远比漏报一次(顶多一个可恢复的 git 冲突)代价大。
- 怎么选:比较"误拦的代价"和"漏报的代价",往代价更大的那一侧的**反方向**倒。

**2. 永不阻断——只提醒,不否决。** 两个钩子都不返回 block/deny。钩子在每次会话启动/停止/编辑时都跑,所以一个"能拦"的钩子一旦有 bug,就成了能锁死整个工作流的单点。它们只发提醒或悄悄调状态。代价是放弃强制力;回报是坏掉的钩子永远锁不死你。

**3. 原子写——先写临时文件,再 rename。** 闸的状态存在一个小 `state.json` 里。就地写有风险:进程中途崩溃或被并发读到,会留下半截损坏的文件——而这文件控制着闸。所以它先写临时文件,再 rename 覆盖目标;rename 在操作系统层是原子的,读者永远只看到完整的旧文件或完整的新文件,绝不会看到撕裂态。

**4. 真隔离 vs 假隔离。** "同目录、不同分支"像隔离其实不是:checkout、branch -D、rebase 动的都是同一份 HEAD/index/refs,同一 checkout 里的两个会话仍会互相腐蚀。真隔离是**一会话一个 git worktree**——各有独立的工作目录、HEAD、暂存区,只共享(安全、基本只读的)对象库。`wt.ps1` 用一条命令把它变成默认。

---

## Install & use

### Requirements
- **Node >= 22** (the hooks and tools use Node built-ins only).
- **git** with worktree support.
- **Windows PowerShell 5.1+** or **pwsh** (for `wt.ps1`).
- **Tested on Windows.** No cross-platform guarantee — the logic is portable, but it has only been exercised on Windows.

### Hooks
Copy the two hook files into `~/.claude/ccg/`, then merge [`examples/settings.snippet.json`](examples/settings.snippet.json) into your Claude Code `settings.json`:

PowerShell:

```powershell
New-Item -ItemType Directory -Force ~/.claude/ccg | Out-Null
Copy-Item hooks/review-gate-autosync.mjs, hooks/same-repo-warden.mjs ~/.claude/ccg/
```

Git Bash:

```bash
mkdir -p ~/.claude/ccg && cp hooks/review-gate-autosync.mjs hooks/same-repo-warden.mjs ~/.claude/ccg/
```

The snippet wires three events:
- **SessionStart** → both hooks (sync the gate, check for a same-repo session).
- **Stop** → `review-gate-autosync` (enforce / step aside at stop time).
- **PreToolUse** with matcher `Edit|Write` → `same-repo-warden` (warn before an edit lands).

### Worktree manager
Run from inside the repo (any worktree — the script finds the main one itself):

```powershell
pwsh -File scripts/wt.ps1 new <slug>    # create branch feat/<slug> + sibling worktree wt-<slug>
pwsh -File scripts/wt.ps1 list          # list worktrees: branch, clean/dirty, ahead/behind main
pwsh -File scripts/wt.ps1 status        # integration board: which feat/* branches are merged yet
pwsh -File scripts/wt.ps1 rm <slug>     # tear a worktree down (refuses if dirty unless -Force)
```

Read [`docs/parallel-dev-worktree.md`](docs/parallel-dev-worktree.md) for the convention (the `feat/<slug>` ↔ `wt-<slug>` mapping), the rationale, and the single-integrator merge protocol.

### Leak-guard
```bash
npm run leakguard    # scans the working tree; exits non-zero on any personal data
```
Prints `leak-guard: clean` and exits 0 when nothing is found. For project-specific private strings (names, hostnames, internal slugs), add a gitignored `.leakguard-local.txt` denylist — one literal string per line — and any committed file containing one fails the scan.

### Tests
```bash
npm test    # node --test
```

### Autosync fragility note (honest caveat)
`review-gate-autosync` depends on the Codex plugin's internal `state.json` shape and on Codex's `logs_*.sqlite` to read your remaining quota. **Neither is a public, stable contract** — a Codex or plugin version bump can change either and quietly break the sync. It is pinned to the versions it was tested against; if your Codex updates, re-verify the gate before relying on it.

> **中文**
>
> ### 环境要求
> - **Node >= 22**(钩子和工具只用 Node 内置模块)。
> - 支持 worktree 的 **git**。
> - **Windows PowerShell 5.1+** 或 **pwsh**(用于 `wt.ps1`)。
> - **已在 Windows 上测试。** 不保证跨平台——逻辑是可移植的,但只在 Windows 上跑过。
>
> ### 钩子
> 把两个钩子文件复制到 `~/.claude/ccg/`,再把 [`examples/settings.snippet.json`](examples/settings.snippet.json) 合并进你的 Claude Code `settings.json`:
>
> PowerShell:
>
> ```powershell
> New-Item -ItemType Directory -Force ~/.claude/ccg | Out-Null
> Copy-Item hooks/review-gate-autosync.mjs, hooks/same-repo-warden.mjs ~/.claude/ccg/
> ```
>
> Git Bash:
>
> ```bash
> mkdir -p ~/.claude/ccg && cp hooks/review-gate-autosync.mjs hooks/same-repo-warden.mjs ~/.claude/ccg/
> ```
>
> 这段配置接入三个事件:
> - **SessionStart** → 两个钩子都跑(同步闸 + 检查是否有同仓会话)。
> - **Stop** → `review-gate-autosync`(在停止时强制 / 让开)。
> - **PreToolUse**(matcher 为 `Edit|Write`)→ `same-repo-warden`(编辑落盘前提醒)。
>
> ### worktree 管理器
> 在仓库内任意位置运行(任一 worktree 都行——脚本会自己找到主 worktree):
>
> ```powershell
> pwsh -File scripts/wt.ps1 new <slug>    # 创建分支 feat/<slug> + 兄弟目录 worktree wt-<slug>
> pwsh -File scripts/wt.ps1 list          # 列出 worktree:分支、干净/脏、相对 main 的领先/落后
> pwsh -File scripts/wt.ps1 status        # 集成看板:哪些 feat/* 分支已并入 main
> pwsh -File scripts/wt.ps1 rm <slug>     # 拆掉一个 worktree(有未提交改动时拒绝,除非加 -Force)
> ```
>
> 约定(`feat/<slug>` ↔ `wt-<slug>` 的映射)、设计动机,以及「单一集成者」的合并协议,见 [`docs/parallel-dev-worktree.md`](docs/parallel-dev-worktree.md)。
>
> ### leak-guard
> ```bash
> npm run leakguard    # 扫描工作树;发现任何个人数据就以非零退出
> ```
> 什么都没找到时打印 `leak-guard: clean` 并以 0 退出。对项目专属的私有字符串(姓名、主机名、内部 slug),加一个被 gitignore 的 `.leakguard-local.txt` 黑名单——每行一个字面字符串——任何被提交的文件只要含其中之一就会扫描失败。
>
> ### 测试
> ```bash
> npm test    # node --test
> ```
>
> ### autosync 脆弱性提醒(诚实交代)
> `review-gate-autosync` 依赖 Codex 插件内部 `state.json` 的结构,以及 Codex 的 `logs_*.sqlite` 来读取你的剩余额度。**这两者都不是公开、稳定的契约**——Codex 或插件升一个版本就可能改动其中之一,从而悄悄让同步失效。它被钉死在测试过的版本上;如果你的 Codex 升级了,在依赖这道闸之前请重新验证。

---

## Appendix & caveats

The dated model/pricing comparison that motivates the dual-engine split lives in [`docs/appendix-benchmarks-2026-06.md`](docs/appendix-benchmarks-2026-06.md). Read it with these caveats firmly in mind:

- The figures are **mixed-source** (vendor self-reported numbers, third-party leaderboards, single-practitioner reports), **dated 2026-06**, and **not independently verified**.
- The **harness effect** — the same model scoring differently inside different CLI shells — can dominate the model-to-model difference. Treat any single number as *directional, not definitive*, and read each comparison as a *shell + model* pairing rather than a pure model verdict.

> **中文**
>
> 驱动「双引擎拆分」的那份带日期的模型/价格对比在 [`docs/appendix-benchmarks-2026-06.md`](docs/appendix-benchmarks-2026-06.md)。读它时请牢记这些注意事项:
>
> - 这些数字是**多来源混合的**(厂商自报、第三方榜单、单个实践者报告),**日期为 2026-06**,且**未经独立验证**。
> - **harness effect**(同一个模型在不同 CLI shell 里跑出不同分数)可能盖过模型与模型之间的差异。把任何单一数字都当成*方向性、而非定论*,并把每条对比都读成一组*shell + 模型*的组合,而不是对模型本身的判决。

---

## License

MIT — see [`LICENSE`](LICENSE).

GitHub topics: `claude-code`, `codex`, `ai-pair-programming`, `code-review`, `git-worktree`, `windows`.

> **中文**
>
> MIT 许可证 —— 见 [`LICENSE`](LICENSE)。
>
> GitHub topics:`claude-code`、`codex`、`ai-pair-programming`、`code-review`、`git-worktree`、`windows`。
