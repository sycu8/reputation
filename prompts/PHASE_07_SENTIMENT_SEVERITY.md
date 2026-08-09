# Codex Prompt — Phase 7: Target-aware Sentiment and Severity

You are a senior applied-ML/product-risk engineer.

## Objective

Classify sentiment toward the monitored entity and generate an explainable severity score without allowing keywords alone to create Critical incidents.

## Pipeline

1. deterministic filters
2. cheap classifier
3. confidence gating
4. deep analysis only for uncertain/high-risk candidates
5. structured severity engine

## Required output schema

- sentiment: positive/neutral/negative
- sentiment confidence
- monitored target
- topic
- risk category
- structured reason codes
- severity 0-100
- classifier/model version

## Severity inputs

Use the documented weights/rules as configuration, not hard-coded magic scattered across the repo. Include engagement/velocity only when reliable source data exists.

## Tests

- text positive toward A but negative toward B classifies each target correctly
- phrase containing `scam` without accusation does not become Critical by keyword alone
- strong direct complaint becomes negative/high when evidence supports it
- low-confidence result is reviewable and does not silently alert as high confidence
- deterministic fixture outputs are stable enough for regression tests
