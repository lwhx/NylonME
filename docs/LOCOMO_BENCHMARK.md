# LoCoMo Benchmark — Method and Results

Latest full run: **2026-09-23**, commit `e49ce38`. All numbers on the full
10-session LoCoMo corpus (1,536 answerable QA in 4 categories; 1,530 judged
end-to-end).

## Headline

| Metric | Value |
|---|---|
| Evidence recall@10 | **85.9%** |
| End-to-end QA accuracy, paper protocol (Mem0 Appendix A wording) | **80.1%** |
| End-to-end QA accuracy, strict protocol (semantic equivalence) | **74.1%** |

Per-category (paper protocol J):

| Category | recall@10 | J |
|---|---|---|
| 1 multi-hop | 82.3% (232/282) | 68.6% (192/280) |
| 2 temporal | 88.8% (285/321) | 78.9% (250/317) |
| 3 commonsense / open-domain | 58.7% (54/92) | 65.2% (60/92) |
| 4 single-hop | 89.1% (749/841) | 86.1% (724/841) |

## Protocol

- **Weaving**: dual-layer write — leaf layer stores raw dialogue turns,
  abstract layer stores session-level facts distilled by an LLM
  (deepseek-v4-flash), with explicit inter-layer edges. Async commonsense
  reflection adds world-knowledge bridge nodes (diffusion-only, filtered
  from output).
- **Retrieval**: hybrid lexical + vector (bge-m3) seeds → context resonance
  (graph diffusion with tension decay, global activation budget) →
  query-vector rerank (`0.5 * resonance + 0.5 * cosine`) → seed hoisting
  (quota 10). Single-hop-style queries use adaptive depth 0 (no diffusion).
- **Answering**: LLM (k3) answers from the retrieved Top-10 with an
  anti-abstention, specificity-preferring prompt.
- **Judging**: two LLM judges per answer — paper protocol (generous,
  topic-overlap counts as correct, per Mem0 Appendix A) and a strict
  semantic-equivalence protocol. We report both; all A/B decisions use
  paired runs on an identical weave.

## Ablations (10-session recall@10, paired)

| Config | recall@10 | Δ |
|---|---|---|
| Full system | 85.9% | — |
| − async reflection | 85.3% | −0.1 (noise) |
| − vector rerank | 84.0% | −1.4 |
| − adaptive depth (all cats diffuse) | 83.4% | −2.0 |
| − abstract layer (leaf-only) | 71.2% | **−14.2** |
| − embedding channel (lexical-only) | 75.2% | **−10.2** |

Answer-side ablation (identical weave, 10-session e2e):

| Config | J (paper) | strict |
|---|---|---|
| Conservative answering prompt ("Not mentioned" if unsure) | 76.4% | 69.9% |
| Anti-abstention + specificity prompt | **80.1%** | **74.1%** |

## Notes and caveats

- Write-side LLM weaving is non-deterministic; re-weaving the corpus moves
  recall by roughly ±1.5pp. Deltas at or below that band are read as
  "small or zero".
- Reflection (world-knowledge bridges) is recall-neutral on this benchmark
  (paired ablation, both retrieval- and answer-level); we report it as a
  negative result rather than a selling point.
- Multi-path corroboration (graph-structural ranking boost) was implemented
  and A/B-tested (in-graph and post-blend, bonus 0.2/1.0, plus relaxed seed
  quota): all within noise. Top-10 is dominated by seed hoisting; ranking
  is saturated. The remaining retrieval frontier is seed-layer recall
  (evidence never found), not ordering.
- A wrong-answer autopsy of the 76.4% baseline: 361 errors = 163
  abstentions (57 with all evidence present) + 198 content errors (80 with
  full evidence). This decomposition motivated the answer-side prompt,
  which recovered 57 questions net.

## Reproducing

The evaluation lives in `engine/crates/nylon-engine/tests/locomo_eval.rs`
(ignored by default). Entry points: `NYLON_LOCOMO_PATH` (dataset),
`NYLON_EVAL_E2E=1` (QA + judging), `NYLON_EVAL_STORE_DIR` (weave cache),
`NYLON_EVAL_QA_PROMPT_V2=1` (anti-abstention answering).
