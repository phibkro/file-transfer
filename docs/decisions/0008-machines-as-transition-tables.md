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

## Consequences

- A life cycle has one definition, shared by the reference layer and every platform layer.
- Guards that need context (a credit is unspent) are named in `when` for the diagram and enforced in code; the table records that they exist.
- Not every service needs a machine: quota windows, telemetry counters and abuse notices have none yet. A notice gains one when appeals arrive.
