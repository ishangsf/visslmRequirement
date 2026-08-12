# Requirement Matching Gold Protocol

This directory contains evaluation scaffolding and the user-specified contract fixture. It does not claim to contain 200 human-labeled queries or 3,000 human-labeled pairs.

## Gold record

Each query has one `baseItemId`, one query-level split, and a list of candidate pairs. The pair relation is one of `duplicate`, `highly_similar`, `partial_overlap`, `same_pattern`, `topic_only`, or `unrelated`. Graded relevance is 3 for duplicate, 2 for highly similar, 1 for partial overlap or same pattern, and 0 for topic-only or unrelated. The evaluator uses relevance greater than zero as a retrieval-positive pair.

`hardNegative: true` marks a candidate that is lexically or topically plausible but must not become a formal match. It is evaluated separately from ordinary retrieval recall.

## Annotation and adjudication

1. Freeze the query list and assign each base item to exactly one split before annotation. Split at the query level; do not place the same base item in more than one split, and keep all candidates for a base query in that split.
2. Two annotators independently label every pair, record the relation and a short evidence note, and do not see the other annotator's label.
3. An adjudicator reviews every disagreement, records the final relation and reason, and may mark a pair as a hard negative. Preserve the two raw labels instead of overwriting them.
4. Mark the asset `annotationStatus: "ready"` only after the coverage target and disagreement review are complete. Until then, keep `annotationStatus: "scaffold"`; the evaluator intentionally fails the incomplete-data gate.

The target gate is at least 200 queries and 3,000 pairs. The target test split must include formal matches, non-formal references, topic-only negatives, unrelated negatives, and hard negatives. Query identifiers, source provenance, and annotation status are part of the review record.

## Metrics and gates

The evaluator reports Recall@50, formal precision, topic-only-to-formal false-positive rate, nDCG@10, MRR, hard-negative status, coverage, and optional baseline deltas. The default gates are Recall@50 >= 98%, formal precision >= 95%, and topic-only-to-formal FPR <= 5%. nDCG@10 and MRR must be computable; teams may provide explicit minimums with `--min-ndcg10` and `--min-mrr`. A baseline file is compared when supplied with `--baseline`.

The evaluator exits non-zero for an incomplete or failing gate unless `--report-only` is used for exploratory reporting. `--report-only` does not change the reported pass/fail status.

## Contract fixture

`fixed-outcomes.json` records the acceptance outcomes for `VISSLM-TSIS-779`: 889 is topic-only, 376 is topic-only or partial-overlap, 613/395/528 are non-formal, 1837 is same-pattern, and the query has no formal result. The smoke script uses synthetic records to exercise this contract; it is not included in the human gold counts.
