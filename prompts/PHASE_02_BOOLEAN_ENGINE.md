# Codex Prompt — Phase 2: Boolean Query Engine

You are a senior compiler/parser engineer working in this TypeScript monorepo.

## Objective

Build a deterministic canonical Boolean query engine for customer monitors.

## Required features

- tokenizer
- parser
- AST types
- source spans/character offsets for errors
- validator
- normalizer
- evaluator against normalized text fields
- provider compiler interface
- exact phrases
- AND, OR, NOT
- nested parentheses
- Unicode and Vietnamese terms

The canonical AST is authoritative. Provider-specific queries are only discovery approximations and must never replace post-fetch canonical evaluation.

## Grammar requirements

Document operator precedence explicitly. Prefer:

1. parentheses
2. NOT
3. AND
4. OR

Do not invent implicit-AND behavior unless the existing product docs already require it; if supported, document and test it precisely.

## Safety and correctness

- cap query length and AST depth
- reject malformed/unbounded input gracefully
- no `eval`
- deterministic serialization/normalization
- preserve exact phrase boundaries

## Provider compiler

Create an interface capable of compiling subsets for web search, YouTube, X, and future providers. Unsupported operators must be surfaced as capability metadata, not silently dropped.

## Tests

Create truth-table style tests for:

- nested expressions
- NOT precedence
- Unicode/Vietnamese
- exact phrases
- invalid parentheses
- empty operands
- repeated operators
- provider subset compilation
- canonical post-filter correctness

## Process

Inspect first, plan exact files, implement smallest safe patch, validate, update docs/contracts, then report per `AGENTS.md`.
