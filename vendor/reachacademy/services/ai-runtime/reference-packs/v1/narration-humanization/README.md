# Reach Deck narration humanization references

This directory vendors fixed, license-audited source material used to improve Chinese Reach Deck
narration. The files are preserved verbatim from pinned upstream commits so that prompt rules,
examples, and benchmark claims remain auditable.

## Sources

- `blader-humanizer/`: [`blader/humanizer`](https://github.com/blader/humanizer) at commit
  `9862685f575c65a8247f90369951df1b3416e3d6`, MIT, Copyright (c) 2025 Siqi Chen.
- `mrgediao-shuorenhua/`: [`MrGeDiao/shuorenhua`](https://github.com/MrGeDiao/shuorenhua)
  at commit `5a9eafefe03807404135f4d2ee4f42fe61d58759`, MIT, Copyright (c) 2026
  MrGeDiao.

The upstream MIT license is kept beside each vendored source. `manifest.json` records the pinned
commit, original path, normalized-LF SHA-256, local path, and production eligibility.

## Runtime use

The complete third-party skills are reference assets, not a second teacher persona and not an
unbounded prompt include. Reach Deck keeps the OpenMAIC-derived one-to-one Chinese teacher corpus as
the positive voice authority. A small deterministic subset of the third-party rules and complete
before/after examples is represented in
`lib/reach-deck/narration-humanization-sources.ts` and injected under the existing narration style
budget.

The adopted ideas are deliberately narrow:

- state the fact or mechanism instead of staging its importance;
- remove empty dramatic closers, invented objections, forced triads, chatbot wrappers, and inflated
  significance;
- preserve facts, actors, actions, conditions, negation, modality, comparison, degree, formulas,
  and fixed bindings;
- do not rewrite already-natural technical language merely to demonstrate a style change;
- treat weak signals as diagnostic only unless several occur together.

The complete `evals/real-samples.md` file is retained for provenance and benchmark design. Its
general chat and technical-writing examples are not treated as teacher-speech exemplars.
