# 0008 Machines as transition tables

Status: accepted (2026-10-28)

## Context

Rooms and relay sessions have life cycles (open, closed, draining). Encoding them as booleans and scattered `if` statements hides which commands are legal in which state, and lets a platform layer drift from the reference.

Adapted from the machine module of phibkro/vektorprogrammet-reimagined (its ADR 0007), same author; simplified to what this repository uses.

## Decision

- `libraries/machine` declares a life cycle as data: states, commands, terminal states, and transitions `{ command, from, to, when?, guard? }`, with `Machine.boundary` (`[*]`) as the entry.
- Layers ask the table (`Machine.can`, `Machine.next`) instead of re-deriving legality.
- `Machine.problems` reports unreachable states, undeclared dead ends, terminal states with an exit, and commands without a transition; every machine has a test that its problem list is empty.
- `Machine.toMermaid` renders a top-to-bottom state diagram from the same table.
- `Machine.matrix` lists every (state, command) pair, the boundary row included, with what the table says happens: the target state, a guarded choice, or `rejected`. `Machine.toTable` renders it as Markdown. `docs/state-machines.md` is generated from the tables (`bun run docs:machines`) and a test fails when it drifts. The table, not the diagram, is normative, as in RFC 9293 and RFC 9113: it is the one that shows every illegal input.
- `Machine.problems` also reports a command with more than one transition from one state unless every one of them has a guard.
- Every service with a machine declares a `follows-machine` guarantee, checked by `transitionTableCheck` from `@file-transfer/conformance` over every cell: an allowed command succeeds and leaves the declared state, and a rejected one fails with a typed error and leaves the state unchanged. Rejected cells are Binder's "sneak paths", the illegal inputs a list of transitions never tests. Pairs an interface cannot express (creating a resource that already exists) are listed with a reason, and the table must reject them.

## Consequences

- A life cycle has one definition, shared by the reference layer and every platform layer.
- Guards that need context (a credit is unspent) are named in `when` for the diagram and enforced in code; the table records that they exist.
- Not every service needs a machine: quota windows, telemetry counters and abuse notices have none yet. A notice gains one when appeals arrive.
