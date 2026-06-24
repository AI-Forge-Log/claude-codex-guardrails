# Appendix: model and pricing benchmarks (2026-06)

> **Disclaimer.** As of 2026-06. The figures below mix vendor self-reported
> numbers, third-party leaderboards, and single-practitioner reports; they are
> **not independently verified**. The "harness effect" — the same model scoring
> differently inside different CLI shells — can exceed the model-to-model
> difference by **16–36 points** (e.g. one report shows the same model at 77% in
> one harness vs 93% in another). Treat any single number as **directional, not
> definitive**, and read every comparison as a *shell + model* combination
> rather than a pure model comparison.

This appendix captures the model comparison that motivates the dual-engine
workflow: a planning/primary-implementation model paired with an adversarial
reviewer plus parallel executor. It is a snapshot, not a recommendation; the
numbers are provided so the reasoning can be spot-checked, not relied upon.

## Model comparison

Bracketed sources reflect the citations in the source material; they are
reproduced here only to show provenance, not as endorsements.

| Dimension | Claude Code + Opus 4.8 | Codex + GPT-5.5 |
|---|---|---|
| Release | 2026-05-28 | 2026-04-23 |
| Pricing (standard) | $5 / M input, $25 / M output | $5 / M input, $30 / M output |
| Context window | 1M default, 128K output; flat pricing at all lengths | 1M (API) / 400K (in Codex); ~2x input / 1.5x output long-context surcharge above 272K input |
| Fast mode | 2.5x speed / 2x price ($10 / $50); reported ~3x cheaper than the prior generation's fast mode (relative, not an absolute discount) | In Codex: 1.5x speed / 2.5x price (Codex-fast only) |
| SWE-bench Verified | 88.6% | 88.7% (third-party, not an official page) — effectively tied, difference within noise |
| SWE-bench Pro (harder, memorization-resistant) | 69.2% | 58.6% — Opus 4.8 ahead by ~10.6 points |
| Terminal-Bench | 74.6% | 78.2% / 83.4% in the native Codex shell — GPT-5.5 ahead, shell amplifies the lead |
| Long-context retrieval (GraphWalks 1M) | 68.1% | 45.4% — Opus 4.8 ahead by ~22.7 points |
| Speed / token efficiency | Slower, more verbose (422,758 output tokens over 10 tasks) | ~2.3x faster, ~3.35x fewer output tokens (126,107) |
| Measured per-task cost | ~$13.42 | ~$11.34 — real "per completed task" cost often lower for Codex |
| Debugging reliability | ~4x lower rate of letting a bug through vs the prior generation (vendor self-reported, medium confidence); tends to stop and surface the error | Tends toward autonomous trial-and-error / rewrite-to-recover |
| Frontend / UI quality | Practitioner preference goes to Opus 4.8 | — |

### Additional figures from the capability detail

These come from the per-engine breakdown rather than the headline table.

| Metric | Value | Engine |
|---|---|---|
| GPQA (static) | ~93.6% (slightly down vs prior generation) | Opus 4.8 |
| Minimum cacheable prompt | 4,096 tokens | Opus 4.8 |
| Terminal-Bench 2.0 | 82.7% (reported as state-of-the-art) | GPT-5.5 |
| Expert-SWE | 73.1% | GPT-5.5 |
| MRCR v2 8-needle (512K–1M) | 74.0% (vs 36.6% for the prior generation) | GPT-5.5 |
| Knowledge cutoff | 2025-12 | GPT-5.5 |
| Output window | ~128K | GPT-5.5 |
| Cloud credit premium | ~5x (one task: ~7 credits local vs ~34 in cloud) | Codex Cloud |

## Strengths in one line

- **Opus 4.8** is strong at repo-scale multi-file engineering, cross-file
  reference tracking, very-long-context fidelity, frontend quality, instruction
  faithfulness, and a low rate of letting bugs through. It is weaker on speed,
  verbosity, and token cost, and tends to **stall and wait for a human** on
  ambiguity (a risk for unattended runs).
- **GPT-5.5** is strong at terminal/shell automation (fire-and-forget), parallel
  tool calls, speed and token efficiency, autonomous error recovery, and
  subscription cost-effectiveness. It is weaker on SWE-bench Pro, degrades on
  long context as length grows (recency bias), carries a long-context surcharge,
  and can produce multi-file refactors that "look clean but hide cross-file
  inconsistencies."

## Why this motivates a dual-engine workflow

The numbers point to complementary, not interchangeable, engines: one model
holds the architecture and the long-context, multi-file plan; a second, fresh
model with no planning fatigue performs adversarial review and parallel,
mechanical execution. The top trap to keep in mind is the harness effect noted
in the disclaimer — many head-to-head writeups compare across mismatched shells
or against an older model generation, so no single source benchmark should be
read as a verdict.
