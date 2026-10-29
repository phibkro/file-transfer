---
"@file-transfer/machine": minor
"@file-transfer/conformance": minor
"@file-transfer/service-room": minor
"@file-transfer/service-relay": minor
---

Machines now expose their full state × command matrix, illegal pairs included (`Machine.matrix`, `Machine.toTable`), and `Machine.problems` reports a command whose transitions from one state cannot be told apart. `transitionTableCheck` checks a service against every cell of its machine's table, and the room and relay services declare it as their `follows-machine` guarantee. The relay meter now reports the session's state. `docs/state-machines.md` is generated from the tables.
