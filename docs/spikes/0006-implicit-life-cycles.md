# Spike 0006: implicit life cycles of the browser client

Input for gap G2 (`docs/invariants.md`): the life cycles of `apps/web` written down as states over today's variables, proposed as `libraries/machine` tables, with the (state, event) pairs the code handles questionably. Read from `main` at a076e33 on 2026-10-29 by reading the code, not by running it: every finding marked real names the event sequence that reaches it, and each still needs a failing test before its fix. Line numbers refer to `apps/web/src/*.ts` unless another file is named. Verdicts: **real** (wrong behaviour reachable by a concrete sequence), **harmless** (redundant or self-healing), **uncertain** (needs a test before anyone acts on it).

Room facts the analysis relies on (`platforms/cloudflare/src/room.ts:158-263`): the room sends `joined` first, then relays `peer joined` to the other role; a newer join of the same role evicts the older socket with `error` "replaced by a newer connection" and no `peer left`; a closing admitted socket produces `peer left`; an evicted socket is no longer admitted, so its later messages are refused, not relayed.

## 1. Connection (`connection.ts`)

### State variables

| Variable              | Type and values                    | Line    | Notes                                                                    |
| --------------------- | ---------------------------------- | ------- | ------------------------------------------------------------------------ |
| `socket`              | `WebSocket \| undefined`           | 78      | Identity is the guard against stale sockets (`socket !== current`, 210). |
| `joined`              | boolean                            | 79      | Gates `sendControl` (86) and `sendUnit` (282).                           |
| `epoch`               | counter, +1 per `joined`           | 80, 229 | Tags units so the recipient can ignore credits for an old join.          |
| `attempts`            | counter, 0 after `joined`          | 81, 228 | Backoff exponent; `connecting` versus `reconnecting` (200).              |
| `stopped`             | boolean                            | 82      | Set by `close()` (294) or any room `error` (250); never cleared.         |
| `direct`              | `DirectPath \| undefined`          | 83      | Plus its own `open`, `closed` (`direct.ts:63-64`).                       |
| `liveness`            | interval handle                    | 193     | Started only at `joined` when `answersPings` (232-245).                  |
| `lastHeard`, `pinged` | per socket, in `connect`'s closure | 204-205 | Reset by any frame on the current socket, including `pong`.              |
| backoff timer         | not stored                         | 190     | `close()` cannot cancel it; `connect` checks `stopped` (196).            |

### Events

- Socket life cycle: `open` (206, sends `join`), `close` (270 → `dropSocket` 172), silence limit from the liveness tick (237-239), ping due (240-242). There is no `error` listener (the browser follows `error` with `close`) and **no timeout before `joined`**.
- Room messages on the current socket (209-269): `joined` (226), `error` (249), `signal` (144), `peer` (156, steers the direct path, then passes on), everything else passes to `onControl` (257); binary frames go to `onUnit` with the current epoch (262-267).
- Direct path: `onOpen` (123), `onClose(wasOpen)` (128), `onFrame` (116), plus inside `direct.ts`: channel `open`/`close`/`error` (91-99), `connectionstatechange` to `failed` or `closed` (115-120), 15 s open timeout (81-85), `bufferedamountlow` (105).
- Caller: `sendControl`, `sendUnit`, `untilWritable`, `close` (293).
- Timers: backoff (190), liveness every 2.5 s (234).

### Derived life cycle

| State        | Predicate                                                  |
| ------------ | ---------------------------------------------------------- |
| `Opening`    | `!stopped && socket?.readyState === CONNECTING`            |
| `Joining`    | `!stopped && socket?.readyState === OPEN && !joined`       |
| `Joined`     | `!stopped && joined`                                       |
| `BackingOff` | `!stopped && socket === undefined` (backoff timer pending) |
| `Stopping`   | `stopped && socket !== undefined` (close event pending)    |
| `Closed`     | `stopped && socket === undefined`                          |

```ts
export const roomConnectionMachine = Machine.make({
  name: "RoomConnection",
  states: ["Opening", "Joining", "Joined", "BackingOff", "Stopping", "Closed"],
  commands: [
    "openConnection",
    "socketOpened",
    "joinedReceived",
    "errorReceived",
    "socketClosed",
    "silenceLimitReached",
    "joinTimeoutElapsed",
    "backoffElapsed",
    "closeRequested",
  ],
  terminal: ["Closed"],
  transitions: [
    { command: "openConnection", from: [Machine.boundary], to: "Opening" },
    { command: "socketOpened", from: ["Opening"], to: "Joining", when: "send join" },
    { command: "joinedReceived", from: ["Joining"], to: "Joined", when: "epoch + 1, attempts = 0, liveness when answersPings" },
    { command: "errorReceived", from: ["Joining", "Joined"], to: "Stopping", when: "refused or replaced: never rejoin" },
    { command: "socketClosed", from: ["Opening", "Joining", "Joined"], to: "BackingOff", when: "attempts + 1, direct path closed" },
    { command: "socketClosed", from: ["Stopping"], to: "Closed" },
    { command: "silenceLimitReached", from: ["Joined"], to: "BackingOff", when: "20 s unheard and the room answers pings" },
    { command: "joinTimeoutElapsed", from: ["Opening", "Joining"], to: "BackingOff", when: "proposed, missing today (C1)" },
    { command: "backoffElapsed", from: ["BackingOff"], to: "Opening", when: "min(5 s, 250 ms × 2^attempts)" },
    { command: "closeRequested", from: ["Opening", "Joining", "Joined"], to: "Stopping" },
    { command: "closeRequested", from: ["Stopping"], to: "Stopping" },
    { command: "closeRequested", from: ["BackingOff"], to: "Closed", when: "today reports no closed state (C3)" },
  ],
})

/** One instance per attempt: `connection.ts` keeps at most one in `direct` and replaces it on every start. */
export const directPathMachine = Machine.make({
  name: "DirectPath",
  states: ["Negotiating", "Open", "Closed"],
  commands: ["startDirect", "channelOpened", "channelFailed", "openTimeoutElapsed", "stopDirect"],
  terminal: ["Closed"],
  transitions: [
    { command: "startDirect", from: [Machine.boundary], to: "Negotiating", when: "sender: a recipient is present; recipient: an offer arrived" },
    { command: "channelOpened", from: ["Negotiating"], to: "Open", when: "path is direct" },
    { command: "channelFailed", from: ["Negotiating"], to: "Closed" },
    { command: "channelFailed", from: ["Open"], to: "Closed", when: "path is relay; the recipient accepts again" },
    { command: "openTimeoutElapsed", from: ["Negotiating"], to: "Closed", when: "15 s" },
    { command: "stopDirect", from: ["Negotiating", "Open"], to: "Closed", when: "socket dropped, other side left, or a new start" },
  ],
})
```

### Questionable pairs

- **C1, (Joining or Opening, silence): real gap.** Liveness starts only after `joined` (232). A socket whose handshake hangs, or that opens and sends `join` but never hears `joined` (room object stuck, half-open during the handshake), is never given up. The status stays "Connecting." or "Reconnecting." with no bound. This is L2's silent socket one step earlier. Sequence: `openConnection, socketOpened`, then nothing.
- **C2 to C4: harmless.** Frames that arrive after `close()` still reach `onControl`, because the listener checks only `socket !== current` (210); callers ignore them through `finished`/`completed`, and replies are dropped by `sendControl` (86). `close()` during backoff never reports `closed` (no socket, so no close event). `reconnecting` is reported twice per drop (189, 200), so the sender bumps `session` twice (459).
- **C5, (Negotiating, a second startDirect): uncertain, performance only.** `signal` carries no path identifier. When the sender starts twice in quick succession (`joined` with recipients, then `peer joined` from a recipient that rejoined; or two recipient rejoins), the recipient answers both offers and the sender applies the first answer to the second `RTCPeerConnection` (149; `direct.ts:157`), then fails on the second answer (stable state) and closes. The transfer stays on the relay until the next join. Needs a network-lab test.
- **D1, (Open, ICE `disconnected`): uncertain.** `direct.ts:115-120` closes only on `failed` or `closed`. If the recipient has already closed its side, the sender keeps sending into a channel whose buffer never drains; `pump` waits on `untilWritable` until ICE declares `failed`. Bounded, but possibly tens of seconds of stall.
- **C6, (Joined, errorReceived): harmless.** `error` leaves `joined` true and liveness running until the close arrives; if it never does, the silence limit still ends in `closed`.

## 2. Sender (`sender.ts`)

Two closures: the page (`startSender`, 469) and the serving loop (`serve`, 193).

### State variables

| Variable              | Type and values                                          | Line     |
| --------------------- | -------------------------------------------------------- | -------- |
| `selected`            | `readonly Entry[]`                                       | 482      |
| `sealed`              | boolean, set once in `begin`                             | 483, 588 |
| `serverLimits`        | `ServerLimits \| undefined`                              | 484      |
| `everSent`            | `RecordSet`, monotonic                                   | 202      |
| `balance.available`   | credits held                                             | 203      |
| `pagesSent`           | `Set<number>`                                            | 204      |
| `schedule`            | `Schedule \| undefined` (defined only after an `accept`) | 205      |
| `awaitingFirstCredit` | boolean                                                  | 206      |
| `session`             | counter, guards the async pump                           | 207      |
| `pumping`             | boolean, one pump at a time                              | 208      |
| `finished`            | boolean                                                  | 209      |

### Events

- Room messages (`onControl`, 316): `joined` (322), `peer` (333), `accept` (350), `decline` (369), `credit` (377), `want` (389), `complete` (412), `abort` (422), `error` (428); `join` and `signal` ignored (435).
- Direct path: `onPath` (311) restarts the pump.
- Socket life cycle: `onState("reconnecting")` (458); every other state is ignored.
- Pump completions: a sealed record (280), a label page (270), a drained send buffer (303-308), a thrown error (296).
- User: file input `change` (643), drop (670), rename and remove (524, 541), "Seal parcel and create link" (648), "Send other files" (660). Async: `fetchServerLimits` (652), `prepare` (604), `createRoom` (615), `directOption` (619).

### Derived life cycle

Page: `Selecting` (`!sealed`), `Sealing` (`sealed`, `prepare` pending), `CreatingRoom`, `ResolvingDirectSettings` (619), `Serving`, `SetupFailed` (the `catch` at 635).

Serving:

| State                             | Predicate                                                    | `report.ts` status      |
| --------------------------------- | ------------------------------------------------------------ | ----------------------- |
| `Connecting`                      | `!finished`, not yet joined once                             | `creating-room` (stale) |
| `WaitingForRecipient`             | joined, no recipient, `schedule === undefined`               | `waiting-for-recipient` |
| `Offering`                        | joined, contract sent this session, `schedule === undefined` | `offering`              |
| `AwaitingFirstCredit`             | `schedule !== undefined && awaitingFirstCredit`              | `transferring`          |
| `Sending`                         | `schedule !== undefined && !awaitingFirstCredit`             | `transferring`          |
| `Reconnecting`                    | `!connection.isJoined()`, `schedule === undefined`           | `reconnecting`          |
| `Delivered`, `Declined`, `Failed` | `finished`, told apart only by the text shown                | as named                |

`WaitingForRecipient` and `Offering` share every variable; only the last message tells them apart, so the reducer needs an explicit phase.

```ts
export const senderPageMachine = Machine.make({
  name: "SenderPage",
  states: ["Selecting", "Sealing", "CreatingRoom", "ResolvingDirectSettings", "Serving", "SetupFailed"],
  commands: ["pageOpened", "selectionChanged", "sealRequested", "parcelSealed", "roomCreated", "directSettingsResolved", "setupFailed", "startOver"],
  terminal: ["Serving"],
  transitions: [
    { command: "pageOpened", from: [Machine.boundary], to: "Selecting" },
    { command: "selectionChanged", from: ["Selecting"], to: "Selecting", when: "add, remove or rename" },
    { command: "sealRequested", from: ["Selecting"], to: "Sealing", when: "at least one file, under the relay limit" },
    { command: "parcelSealed", from: ["Sealing"], to: "CreatingRoom" },
    { command: "roomCreated", from: ["CreatingRoom"], to: "ResolvingDirectSettings", when: "link shown" },
    { command: "directSettingsResolved", from: ["ResolvingDirectSettings"], to: "Serving" },
    { command: "setupFailed", from: ["Sealing", "CreatingRoom"], to: "SetupFailed" },
    { command: "startOver", from: ["SetupFailed"], to: "Selecting", when: "proposed, missing today (S1)" },
  ],
})

export const senderTransferMachine = Machine.make({
  name: "SenderTransfer",
  states: ["Connecting", "WaitingForRecipient", "Offering", "AwaitingFirstCredit", "Sending", "Reconnecting", "Delivered", "Declined", "Failed"],
  commands: [
    "serveStarted",
    "joinedAlone",
    "joinedWithRecipient",
    "recipientJoined",
    "recipientLeft",
    "acceptReceived",
    "acceptMismatched",
    "declineReceived",
    "creditReceived",
    "wantReceived",
    "recordSent",
    "completeReceived",
    "abortReceived",
    "errorReceived",
    "sendFailed",
    "socketDropped",
    "pathChanged",
  ],
  terminal: ["Delivered", "Declined", "Failed"],
  transitions: [
    { command: "serveStarted", from: [Machine.boundary], to: "Connecting" },
    { command: "joinedAlone", from: ["Connecting", "Reconnecting"], to: "WaitingForRecipient" },
    { command: "joinedWithRecipient", from: ["Connecting", "Reconnecting"], to: "Offering", when: "new session, send the contract" },
    {
      command: "recipientJoined",
      from: ["WaitingForRecipient", "Offering", "AwaitingFirstCredit", "Sending"],
      to: "Offering",
      when: "new session, send the contract",
    },
    { command: "recipientLeft", from: ["Offering", "AwaitingFirstCredit", "Sending"], to: "WaitingForRecipient" },
    {
      command: "acceptReceived",
      from: ["Offering", "AwaitingFirstCredit", "Sending"],
      to: "AwaitingFirstCredit",
      when: "sequence and digest match: new session, full debt, no credit",
    },
    { command: "acceptMismatched", from: ["Offering", "AwaitingFirstCredit", "Sending"], to: "Failed", when: "abort contract-mismatch" },
    { command: "declineReceived", from: ["Offering"], to: "Declined" },
    { command: "creditReceived", from: ["AwaitingFirstCredit", "Sending"], to: "Sending", when: "pump" },
    { command: "creditReceived", from: ["WaitingForRecipient", "Offering"], to: "Offering", when: "ignored: no session (S4)" },
    { command: "wantReceived", from: ["AwaitingFirstCredit"], to: "AwaitingFirstCredit", when: "replace debt" },
    { command: "wantReceived", from: ["Sending"], to: "Sending", when: "prioritise; resend covering label pages" },
    { command: "recordSent", from: ["Sending"], to: "Sending", when: "a credit spent, session unchanged" },
    {
      command: "completeReceived",
      from: ["Offering", "AwaitingFirstCredit", "Sending"],
      to: "Delivered",
      when: "from Offering: complete repeated after the sender rejoined",
    },
    { command: "abortReceived", from: ["Offering", "AwaitingFirstCredit", "Sending"], to: "Failed" },
    { command: "errorReceived", from: ["Connecting", "WaitingForRecipient", "Offering", "AwaitingFirstCredit", "Sending"], to: "Failed" },
    { command: "sendFailed", from: ["Sending"], to: "Failed", when: "source changed or unreadable: abort" },
    { command: "socketDropped", from: ["Connecting", "WaitingForRecipient", "Offering", "AwaitingFirstCredit", "Sending", "Reconnecting"], to: "Reconnecting" },
    { command: "pathChanged", from: ["AwaitingFirstCredit", "Sending"], to: "Sending", when: "pump on the new path" },
  ],
})
```

Two rows in that table are choices, not transcriptions: `creditReceived` from `WaitingForRecipient` lands in `Offering` only to keep one unguarded edge per pair (today it is a silent no-op in both), and `declineReceived` is limited to `Offering` (today any state, S3).

### Questionable pairs

- **S1, (SetupFailed, anything): real, dead end.** `sealed` is set before `prepare` (588) and the controls are hidden (589-594); "Send other files" is revealed only after a successful seal (610). A failure while sealing (a file changed on disk: `NotReadableError`, 121) leaves a page with a failure message and no control at all. A failed `createRoom` (rate limit, 165-169) leaves only "Send other files"; the sealed parcel cannot be retried.
- **S2, (Offering, completeReceived): by design, but unauthenticated.** Needed so the recipient's repeated `complete` ends a sender that rejoined after missing the first one. Like `accept` (G4), anyone who can write to the room socket can make the sender show "Delivered". Only the report is affected.
- **S3 to S5: harmless.** `decline` after an `accept` (369) is reachable only when a second recipient tab evicts the first and declines. `credit` and `want` outside a session are ignored silently (378, 390), and a `want` with invalid ranges is ignored in every state rather than treated as a breach. `steerDirect` runs before `onControl` (connection.ts 253, 257), so on `peer joined` the old direct path's close starts a pump on the old session; the `current !== session` checks (272, 286) discard its work.
- **S6, (AwaitingFirstCredit, wantReceived) truncation: uncertain, performance.** A resume `want` holds at most 1024 ranges (`ranges.ts:61`) and replaces the whole debt (395); further holes wait for the recipient's 5 s stall `want`. Only fragmented losses (the unordered direct path) reach it.
- **S7, (ResolvingDirectSettings, no answer): uncertain.** The link is shown before `directOption()` (619) resolves, and that `fetch` has no timeout; a hanging `/api/direct` means the sender never joins. The recipient has the same wait (713).

## 3. Recipient (`recipient.ts`)

### State variables

| Variable                                                 | Type and values                                           | Line     |
| -------------------------------------------------------- | --------------------------------------------------------- | -------- |
| `linkSecret`                                             | `Uint8Array`, fixed after decode                          | 109      |
| `connection`                                             | `Connection \| undefined` (set after an async start)      | 121, 714 |
| `opener`, `headerBytes`                                  | defined once a header opened                              | 122-123  |
| `manifestPlaintexts`, `manifestRecords`, `manifestTotal` | partial manifest                                          | 124-126  |
| `receiver`, `received`, `fileSizes`                      | defined once the contract opened                          | 127-129  |
| `storage`                                                | `ParcelStorage \| undefined`, defined after `openStorage` | 130      |
| `decision`                                               | `"pending" \| "accepted" \| "declined"`                   | 131      |
| `finished`                                               | boolean: set by decline, stop **and** finish              | 132      |
| `completed`                                              | boolean: every file committed                             | 135      |
| `senderPresent`                                          | boolean                                                   | 136      |
| `chain`                                                  | `Promise<void>`, serialises units                         | 137      |
| `dropped`, `wantTimer`                                   | records ahead of their page, 50 ms timer                  | 138-139  |
| `credits`                                                | `{ granted, consumed }`                                   | 140      |
| `lastCount`                                              | stall detector                                            | 141      |
| `saveNames`, `savable`, `filesRemoved`, `saveLinks`      | download phase                                            | 145-151  |
| Accept and Decline buttons                               | DOM, removed only by their own clicks                     | 373-388  |

### Events

- Units (serialised by `chain`, 595): `header` (572 → `onHeader` 427), `manifestRecord` (577 → 448), `labelPage` (582 → 474), `dataRecord` (587 → 491, `current` from the epoch).
- Room messages (`onControl`, 608): `joined` (628), `peer` (641), `abort` (655), `error` (661), the rest ignored (668); a separate branch while `completed` (609-621).
- Direct path: `onPath` (682). Socket life cycle: `onState` (723).
- User: Accept (376), Decline (380), rename (164), Save (182), Save all (291), Remove (307, also the storage panel through `offerRemoval`, 326).
- Timers: `wantTimer` (512 → `flushWant` 335), stall interval (691), completion linger (272).
- Async completions outside the chain: `openStorage` (354), `storage.commit` (269), `checkSpace` (409), start-up (709-713).

### Derived life cycle

| State              | Predicate                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `Connecting`       | `!finished && opener === undefined && connection?.isJoined() !== true`                      |
| `WaitingForSender` | `!finished && opener === undefined && connection.isJoined()`                                |
| `ReadingContract`  | `!finished && opener !== undefined && receiver === undefined`                               |
| `Reviewing`        | `!finished && receiver !== undefined && decision === "pending"`                             |
| `OpeningStorage`   | `!finished && decision === "accepted" && storage === undefined`                             |
| `Receiving`        | `!finished && storage !== undefined && senderPresent && connection.isJoined()`              |
| `Interrupted`      | as `Receiving` but `!senderPresent \|\| !connection.isJoined()`                             |
| `Committing`       | `finished && !completed && isComplete(received)` and no failure (**not expressible today**) |
| `Completed`        | `completed && !filesRemoved`, connection open (linger)                                      |
| `Departed`         | `completed && !filesRemoved`, connection closed                                             |
| `FilesRemoved`     | `filesRemoved`                                                                              |
| `Declined`         | `decision === "declined"`                                                                   |
| `Failed`           | `finished && !completed && decision !== "declined"` and not committing                      |

`Committing` and `Failed` (and a failure that happens while committing) have identical variables; that is the root of R1.

```ts
export const recipientMachine = Machine.make({
  name: "Recipient",
  states: [
    "Connecting",
    "WaitingForSender",
    "ReadingContract",
    "Reviewing",
    "OpeningStorage",
    "Receiving",
    "Interrupted",
    "Committing",
    "Completed",
    "Departed",
    "FilesRemoved",
    "Declined",
    "Failed",
  ],
  commands: [
    "pageOpened",
    "linkInvalid",
    "joinedAlone",
    "joinedWithSender",
    "senderJoined",
    "senderLeft",
    "socketDropped",
    "headerReceived",
    "headerMismatched",
    "contractOpened",
    "acceptClicked",
    "declineClicked",
    "storageOpened",
    "storageFailed",
    "recordStored",
    "lastRecordStored",
    "commitSucceeded",
    "commitFailed",
    "unitRejected",
    "abortReceived",
    "errorReceived",
    "directPathClosed",
    "stallTimerElapsed",
    "lingerElapsed",
    "removeClicked",
  ],
  terminal: ["FilesRemoved", "Declined", "Failed"],
  transitions: [
    { command: "pageOpened", from: [Machine.boundary], to: "Connecting" },
    { command: "linkInvalid", from: [Machine.boundary], to: "Failed" },
    { command: "joinedAlone", from: ["Connecting"], to: "WaitingForSender" },
    { command: "joinedAlone", from: ["Reviewing"], to: "Reviewing", when: "keep the offer and its status (R6)" },
    { command: "joinedAlone", from: ["Receiving", "Interrupted"], to: "Interrupted" },
    { command: "joinedAlone", from: ["Completed"], to: "Completed" },
    { command: "joinedWithSender", from: ["Connecting"], to: "WaitingForSender", when: "the sender will offer" },
    { command: "joinedWithSender", from: ["Reviewing"], to: "Reviewing" },
    { command: "joinedWithSender", from: ["Interrupted"], to: "Interrupted", when: "resume waits for the header" },
    { command: "joinedWithSender", from: ["Completed"], to: "Completed", when: "repeat complete" },
    { command: "senderJoined", from: ["WaitingForSender"], to: "WaitingForSender" },
    { command: "senderJoined", from: ["Reviewing"], to: "Reviewing" },
    { command: "senderJoined", from: ["Receiving", "Interrupted"], to: "Receiving", when: "restore the status text (R6)" },
    { command: "senderJoined", from: ["Completed"], to: "Completed", when: "repeat complete" },
    { command: "senderLeft", from: ["WaitingForSender"], to: "WaitingForSender" },
    { command: "senderLeft", from: ["Reviewing"], to: "Reviewing" },
    { command: "senderLeft", from: ["Receiving", "Interrupted"], to: "Interrupted" },
    { command: "senderLeft", from: ["Completed"], to: "Completed", when: "keep lingering (R4)" },
    { command: "socketDropped", from: ["Connecting", "WaitingForSender"], to: "Connecting" },
    { command: "socketDropped", from: ["ReadingContract"], to: "ReadingContract", when: "the re-offered header restarts it" },
    { command: "socketDropped", from: ["Reviewing"], to: "Reviewing" },
    { command: "socketDropped", from: ["OpeningStorage"], to: "OpeningStorage" },
    { command: "socketDropped", from: ["Receiving", "Interrupted"], to: "Interrupted" },
    { command: "socketDropped", from: ["Completed"], to: "Completed" },
    { command: "headerReceived", from: ["WaitingForSender", "ReadingContract"], to: "ReadingContract", when: "(re)start the manifest" },
    { command: "headerReceived", from: ["Reviewing"], to: "Reviewing", when: "same header: ignored" },
    { command: "headerReceived", from: ["Receiving", "Interrupted"], to: "Receiving", when: "same header: accept, want missing, credit" },
    { command: "headerReceived", from: ["Completed"], to: "Completed", when: "repeat complete" },
    { command: "headerMismatched", from: ["Reviewing", "OpeningStorage", "Receiving", "Interrupted"], to: "Failed" },
    { command: "contractOpened", from: ["ReadingContract"], to: "Reviewing" },
    { command: "acceptClicked", from: ["Reviewing"], to: "OpeningStorage", when: "space suffices" },
    { command: "declineClicked", from: ["Reviewing"], to: "Declined", when: "decline must reach the sender (R5)" },
    { command: "storageOpened", from: ["OpeningStorage"], to: "Receiving", when: "accept, credit" },
    { command: "storageOpened", from: ["Failed"], to: "Failed", when: "discard and release the lock (R3)" },
    { command: "storageFailed", from: ["OpeningStorage"], to: "Failed" },
    { command: "recordStored", from: ["Receiving"], to: "Receiving", when: "consume a credit when current, top up" },
    { command: "recordStored", from: ["Interrupted"], to: "Interrupted", when: "queued record from an earlier join" },
    { command: "lastRecordStored", from: ["Receiving", "Interrupted"], to: "Committing" },
    { command: "commitSucceeded", from: ["Committing"], to: "Completed", when: "send complete, start the linger" },
    { command: "commitFailed", from: ["Committing"], to: "Failed", when: "abort, discard (R1)" },
    {
      command: "unitRejected",
      from: ["WaitingForSender", "ReadingContract", "Reviewing", "OpeningStorage", "Receiving", "Interrupted"],
      to: "Failed",
      when: "parcel error: abort",
    },
    { command: "abortReceived", from: ["WaitingForSender", "ReadingContract", "Reviewing", "OpeningStorage", "Receiving", "Interrupted"], to: "Failed" },
    { command: "abortReceived", from: ["Committing"], to: "Committing", when: "ignored" },
    {
      command: "errorReceived",
      from: ["Connecting", "WaitingForSender", "ReadingContract", "Reviewing", "OpeningStorage", "Receiving", "Interrupted"],
      to: "Failed",
    },
    { command: "directPathClosed", from: ["Receiving"], to: "Receiving", when: "accept again on the relay" },
    { command: "stallTimerElapsed", from: ["Receiving"], to: "Receiving", when: "no record for 5 s: want everything missing" },
    { command: "lingerElapsed", from: ["Completed"], to: "Departed", when: "120 s" },
    { command: "removeClicked", from: ["Completed", "Departed"], to: "FilesRemoved" },
  ],
})
```

The table is the proposed behaviour; where today's code differs, the `when` text names the finding. `storageOpened` from `Failed` is a self-loop on a terminal state, which `Machine.problems` allows, so the late completion has a row that cleans up instead of resuming.

### Questionable pairs

- **R1, (Committing, commitFailed): real bug.** `finish` sets `finished` (267) before `await storage.commit()` (269). If the commit rejects (quota while closing a writable, a WebKit write error), the exception reaches `fail` through the chain (603), and `stop` returns at once because `finished` is already true (208). No `abort` goes out, nothing is discarded, the Web Lock stays held, the status stays "transferring" at 100 %, the stall timer has stopped (692), and the sender waits forever. Sequence: `storageOpened, recordStored × n, lastRecordStored, commitFailed`.
- **R2, (Failed, acceptClicked) and (Failed, declineClicked): real bug.** `stop` never removes the Accept and Decline buttons (373-388), and `onAccept` checks only `decision` (347), not `finished`. Sequence: `contractOpened, abortReceived` (or `errorReceived`, or a parcel error), then Accept. Storage is opened (creating the directory and holding the lock with nothing to release them), the status becomes "transferring" and the text "Receiving." replaces the failure. Decline instead overwrites "failed" with "declined".
- **R3, (OpeningStorage, abortReceived) then storageOpened: real bug.** `onAccept` resumes after `await openStorage` (354) without checking `finished`; `stop` ran meanwhile and found `storage` undefined, so nothing is discarded. Same outcome as R2. This is the chain race the brief asked about: `onAccept` runs outside `chain`, so a control message interleaves with it.
- **R4, (Completed, senderLeft): real bug.** The linger exists because a `complete` sent while the sender reconnects is lost (133-135), but `peer left` from the sender closes the connection at once (615-618), assuming the sender finished. A sender whose socket closed cleanly (service restart 1012, a network change that resets TCP) just as `complete` was relayed produces exactly this `peer left`; it rejoins to `recipientCount: 0` and waits in "Waiting for the recipient" forever. Sequence: `lastRecordStored, commitSucceeded` (complete lost), `senderLeft`, then the sender's `joined`.
- **R5, (Reviewing while the socket is down, declineClicked): real, minor.** `sendControl` drops the decline while not joined (connection.ts 86); the recipient then closes. The sender sees `peer left` (or nothing, for a half-open socket) and waits for a recipient that will never return. Accept in the same situation heals itself, because the sender's re-offer triggers `sendAcceptance(true)` (434).
- **R6, statuses: real, minor (affects `data-status` that end-to-end tests read).** `peer joined` from the sender changes nothing (646-650), so after a sender drop and return the text keeps saying "The sender disconnected" while records arrive; `peer left` never sets a status, so `data-status` says `transferring` while the sender is gone. A rejoin with the sender present in `Reviewing` sets `waiting-for-sender` (634-636) while the offer is on screen, and the re-offered header leaves it there (434).
- **R7, (Receiving, directPathClosed) with records queued: uncertain, flow control.** `onPath` calls `sendAcceptance(true)` synchronously (686), outside `chain`, resetting `credits`. Data records still queued in `chain` from the same epoch then each `consume` (544) against a grant they were not part of, so `outstanding` is underestimated and `grantDue` over-grants. Up to twice the 256-record window can be in flight, which is the bound the relay's Durable Object memory budget assumes (74). Two offers in a row (C5's double start) do the same through two `accept`s. Needs the property in section 5.
- **R8, (OpeningStorage, headerReceived): harmless.** A re-offered header sends an acceptance before storage exists (434); the records that follow are dropped at 492 without consuming credit, and `onAccept`'s own acceptance (366) resets the session.
- **R9, (ReadingContract, manifest record out of order): latent.** Records are taken only in order (449), which holds because every offer follows a fresh `startDirect` and so travels on the ordered relay. An offer over an open, unordered channel would hang in `ReadingContract`.
- **R10, (Receiving, abortReceived) during a write: uncertain.** `stop` aborts writables while a `chain` item awaits `storage.write` (523); the write rejects and its `fail` is a no-op. Worth one WebKit test.

Combinations the brief asked about that turn out to be legitimate: "finished but not accepted" is `Failed` reached from `Reviewing` (but see R2); "completed while the sender is absent" is the linger working as designed (but see R4).

## 4. Proposed tests

Model-based tests with `fc.commands`, the model being the tables above plus a small context (records held, credits outstanding, sender session). Run against the reducers from section 5 with fake socket, timers and storage; before that, against the closures with a fake `WebSocket` and fake timers. Every run also asserts the matrix: a rejected (state, command) pair leaves the state unchanged and emits no effect. First sequences to cover, shortest first:

1. Recipient `contractOpened, abortReceived, acceptClicked`: stays `Failed`; `openStorage` is never called; status `failed` (R2).
2. Recipient `acceptClicked, abortReceived, storageOpened`: `Failed`; storage discarded, lock released (R3).
3. Recipient `…, lastRecordStored, commitFailed`: `Failed`; one `abort` sent; status `failed` (R1).
4. Recipient `…, commitSucceeded, senderLeft, joinedWithSender` (sender side): `complete` is sent again; the sender ends `Delivered` (R4).
5. Recipient `contractOpened, socketDropped, declineClicked, joinedWithSender`: the sender ends `Declined` (R5).
6. Recipient `Receiving, senderLeft, senderJoined, headerReceived`: status `transferring` and text "Receiving." (R6).
7. Credit property, both ends together: for every prefix, records the sender may still send plus records in flight never exceed the window; generate `directPathClosed` and double offers between `recordSent` steps (R7).
8. Connection `openConnection, socketOpened`, then the clock advances 30 s with no frame: a new socket is opened (C1, fails today).
9. Connection `Joined`, 20 s of silence, then `error` on the old socket: ignored; the new socket joins.
10. Connection `errorReceived, socketClosed`: `Closed`; no backoff timer scheduled.
11. Sender `joinedWithRecipient, completeReceived`: `Delivered` (the legal resume of S2).
12. Sender `acceptReceived, wantReceived, creditReceived`: the records sent are exactly the wanted ranges, label pages first.
13. Sender `Sending, recipientLeft, creditReceived`: no record sent.
14. Sender `joinedWithRecipient, recipientJoined` with signals delivered in order: the direct path still opens (C5).
15. Sender page `sealRequested, setupFailed`: a control to start over exists (S1).

## 5. Refactoring seam

All three closures already funnel inputs through a few handlers, so a pure `step(state, event) => { state, effects }` can replace the bodies of those handlers while the DOM code stays where it is. The reducers are plain TypeScript with no Effect import (CLAUDE.md, ADR 0020: browser code returns plain data). `libraries/machine` has no dependencies, so it is safe in the browser; `apps/web/package.json` must declare `@file-transfer/machine` for `check:graph`. Each reducer consults `Machine.next(table, command, state)` and returns no effects for a rejected pair.

**Connection.** Cut at the `message` listener (209-269), `dropSocket` (172), the liveness tick (234) and `close` (293). Replace object identity (`socket !== current`) with a socket generation number carried on every socket event, so stale events are data the reducer can reject. State: phase, generation, epoch, attempts, `lastHeard`, `pinged`, `answersPings`, direct phase. Effects: `openSocket`, `sendText`, `sendBinary`, `closeSocket(code)`, `schedule(name, milliseconds)`, `cancel(name)`, `emitState`, `emitControl`, `emitUnit(epoch)`, `startDirect(initiator)`, `stopDirect`, `emitPath`. Inject a clock (`now`), a scheduler (timeouts and intervals by name), a socket factory and the `openDirectPath` factory. The join timeout (C1) becomes one more scheduled effect.

**Sender.** Cut at `onControl` (316), `onState` (453) and `onPath` (311). State: phase, session, schedule, balance, `awaitingFirstCredit`, `pagesSent`, `everSent` count. The async `pump` stays an interpreter loop, but each awaited result re-enters as an event (`labelPageReady(session, page)`, `recordSealed(session, index, bytes)`) and the reducer decides whether to send it; that replaces the `current !== session` checks at 272 and 286 with a table row. Inject the connection's `sendUnit`, `sendControl`, `isJoined`, `writable`, the sealer and `readRecord`, and a view sink (`setStatus`, `update`, `progress`). The page machine wraps `begin` (583) the same way.

**Recipient.** The hardest, because unit handling awaits crypto and OPFS inside `chain`. Keep `chain` as the effect runner (it serialises effects, which is right), but make every async completion an event that goes back through `step`: `headerOpened`, `manifestRecordOpened`, `contractOpened`, `pageVerified`, `recordOpened`, `recordAheadOfPage`, `recordStored`, `storageOpened`, `storageFailed`, `commitSucceeded`, `commitFailed`, `unitRejected`. Then `storageOpened` in `Failed` yields `discardStorage` instead of resuming (R2, R3), `commitFailed` has a row (R1), and `directPathClosed` can be queued behind the units already in `chain` instead of resetting credits under them (R7). State: phase, decision, `senderPresent`, the record set, credits, `dropped`, `lastCount`, the saved names. Inject a clock and scheduler (want timer, stall interval, linger), the connection, `openStorage`, the parcel opener (`openHeader`), and a view sink (`say`, `setStatus`, `showOffer`, `removeOfferActions`, `showDownloads`, `progress`). The DOM builders (`renderFiles`, `showOffer`, the download controls) stay as they are and are called from the effect interpreter.
