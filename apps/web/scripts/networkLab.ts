/**
 * A small internet in Linux network namespaces, for the lab suite of the end-to-end checks (endToEnd.ts,
 * `E2E_SUITE=lab`). Needs root and Linux (`ip`, `iptables`, `tc`, `conntrack`, and `turnserver` from coturn for STUN).
 *
 *   root namespace: bridge `labnet` 10.99.0.1/24, the room server and a STUN server on 10.99.0.1
 *     ├── router a (10.99.0.11) ── NAT ── home a (192.168.1.2): the sender's browser
 *     └── router b (10.99.0.12) ── NAT ── home b (192.168.2.2): the recipient's browser
 *
 * Each browser runs inside its home namespace (a wrapper executable starts it there) and loads the app from the room
 * server's address, so every packet crosses its router.
 * The routers translate addresses like home routers do, and can be switched between NAT behaviours, impaired with
 * netem or a token bucket, blackholed, or moved to a new address.
 */
import { chmodSync, writeFileSync } from "node:fs"
import nodePath from "node:path"

export type LabSide = "a" | "b"

/**
 * How a router translates: `open` keeps one external port per internal one (endpoint-independent mapping, which
 * hole punching gets through) behind a firewall that drops unsolicited packets, as home routers do; `symmetric` picks a new random port for every destination, which defeats it without a
 * TURN relay; `udp-blocked` passes no UDP at all.
 */
export type NatBehaviour = "open" | "symmetric" | "udp-blocked"

/** A link impairment on a router's way out to the internet: netem delay, jitter and loss, and a rate limit. */
export interface Impairment {
  readonly delayMilliseconds?: number
  readonly jitterMilliseconds?: number
  readonly lossPercent?: number
  readonly rateMegabits?: number
}

export const serverAddress = "10.99.0.1"

const subnet = (side: LabSide) => (side === "a" ? 1 : 2)

const routerNamespace = (side: LabSide) => `lab-router-${side}`

export const homeNamespace = (side: LabSide) => `lab-home-${side}`

/** Runs a command and throws with its output when it fails; `tolerant` ignores failures. */
const run = (command: readonly string[], tolerant = false): string => {
  const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe" })

  if (result.exitCode !== 0 && !tolerant) {
    throw new Error(`${command.join(" ")} failed (${result.exitCode}): ${result.stderr.toString().trim()}`)
  }

  return result.stdout.toString()
}

const inNamespace = (namespace: string, command: readonly string[], tolerant = false) => run(["ip", "netns", "exec", namespace, ...command], tolerant)

/** The router's address on the internet: 10.99.0.11 or .12, and 10.99.0.21 or .22 after `moveRouter`. */
export const wanAddress = (side: LabSide, moved: boolean) => `10.99.0.${moved ? 2 : 1}${side === "a" ? 1 : 2}`

/** Removes everything `build` made; safe to call when nothing exists. */
export const tearDown = () => {
  for (const side of ["a", "b"] as const) {
    run(["ip", "netns", "del", homeNamespace(side)], true)
    run(["ip", "netns", "del", routerNamespace(side)], true)
  }

  run(["ip", "link", "del", "labnet"], true)
  run(["iptables", "-D", "FORWARD", "-i", "labnet", "-o", "labnet", "-j", "ACCEPT"], true)
}

/** Builds the bridge, both routers and both homes, with open NATs and no impairment. */
export const build = () => {
  tearDown()
  run(["ip", "link", "add", "labnet", "type", "bridge"])
  run(["ip", "addr", "add", `${serverAddress}/24`, "dev", "labnet"])
  run(["ip", "link", "set", "labnet", "up"])
  // Docker sets FORWARD to drop and may pass bridged frames through iptables; let the lab's own traffic through.
  run(["iptables", "-I", "FORWARD", "-i", "labnet", "-o", "labnet", "-j", "ACCEPT"], true)
  run(["sysctl", "-qw", "net.bridge.bridge-nf-call-iptables=0"], true)

  for (const side of ["a", "b"] as const) {
    const router = routerNamespace(side)
    const home = homeNamespace(side)
    run(["ip", "netns", "add", router])
    run(["ip", "netns", "add", home])
    inNamespace(router, ["ip", "link", "set", "lo", "up"])
    inNamespace(home, ["ip", "link", "set", "lo", "up"])

    // Internet side of the router, on the bridge.
    run(["ip", "link", "add", `labw-${side}`, "type", "veth", "peer", "name", `labwr-${side}`])
    run(["ip", "link", "set", `labw-${side}`, "master", "labnet", "up"])
    run(["ip", "link", "set", `labwr-${side}`, "netns", router])
    inNamespace(router, ["ip", "link", "set", `labwr-${side}`, "name", "wan"])
    inNamespace(router, ["ip", "addr", "add", `${wanAddress(side, false)}/24`, "dev", "wan"])
    inNamespace(router, ["ip", "link", "set", "wan", "up"])

    // Home side of the router.
    run(["ip", "link", "add", `labl-${side}`, "type", "veth", "peer", "name", `labh-${side}`])
    run(["ip", "link", "set", `labl-${side}`, "netns", router])
    run(["ip", "link", "set", `labh-${side}`, "netns", home])
    inNamespace(router, ["ip", "link", "set", `labl-${side}`, "name", "lan"])
    inNamespace(router, ["ip", "addr", "add", `192.168.${subnet(side)}.1/24`, "dev", "lan"])
    inNamespace(router, ["ip", "link", "set", "lan", "up"])
    inNamespace(router, ["sysctl", "-qw", "net.ipv4.ip_forward=1"])
    inNamespace(home, ["ip", "link", "set", `labh-${side}`, "name", "eth0"])
    inNamespace(home, ["ip", "addr", "add", `192.168.${subnet(side)}.2/24`, "dev", "eth0"])
    inNamespace(home, ["ip", "link", "set", "eth0", "up"])
    inNamespace(home, ["ip", "route", "add", "default", "via", `192.168.${subnet(side)}.1`])

    setNat(side, "open")
  }
}

/** Replaces the router's translation rules with those of `behaviour`, forgetting every existing translation. */
export const setNat = (side: LabSide, behaviour: NatBehaviour) => {
  const router = routerNamespace(side)
  inNamespace(router, ["iptables", "-t", "nat", "-F"])
  inNamespace(router, ["iptables", "-F", "FORWARD"])
  inNamespace(router, ["iptables", "-F", "INPUT"])
  // A home router's firewall drops unsolicited packets from the internet. Without this, Linux records such a packet
  // (a peer's ICE check that arrives before this side's own) and the outbound packet that follows clashes with the
  // record and gets a different external port, which breaks hole punching; a dropped packet is never recorded.
  inNamespace(router, ["iptables", "-A", "INPUT", "-i", "wan", "-m", "conntrack", "--ctstate", "NEW", "-j", "DROP"])
  inNamespace(router, ["iptables", "-t", "nat", "-A", "POSTROUTING", "-o", "wan", "-j", "MASQUERADE", ...(behaviour === "symmetric" ? ["--random-fully"] : [])])

  if (behaviour === "udp-blocked") {
    inNamespace(router, ["iptables", "-A", "FORWARD", "-p", "udp", "-j", "DROP"])
  }

  inNamespace(router, ["conntrack", "-F"], true)
}

/** Whether the kernel has netem; without it only rate limits apply. */
export const hasNetem = (): boolean => {
  const probe = Bun.spawnSync(["ip", "netns", "exec", routerNamespace("a"), "tc", "qdisc", "add", "dev", "lo", "root", "netem", "delay", "1ms"], {
    stderr: "pipe",
  })

  if (probe.exitCode === 0) {
    inNamespace(routerNamespace("a"), ["tc", "qdisc", "del", "dev", "lo", "root"], true)
  }

  return probe.exitCode === 0
}

/** Impairs the router's way out (both directions are shaped: the wan side going out, the lan side coming in). */
export const impair = (side: LabSide, impairment: Impairment | undefined) => {
  const router = routerNamespace(side)

  for (const device of ["wan", "lan"]) {
    inNamespace(router, ["tc", "qdisc", "del", "dev", device, "root"], true)

    if (impairment === undefined) {
      continue
    }

    const { delayMilliseconds, jitterMilliseconds, lossPercent, rateMegabits } = impairment

    const netem = [
      ...(delayMilliseconds === undefined ? [] : ["delay", `${delayMilliseconds}ms`, ...(jitterMilliseconds === undefined ? [] : [`${jitterMilliseconds}ms`])]),
      ...(lossPercent === undefined ? [] : ["loss", `${lossPercent}%`]),
      ...(rateMegabits === undefined ? [] : ["rate", `${rateMegabits}mbit`]),
    ]

    if (delayMilliseconds !== undefined || lossPercent !== undefined) {
      inNamespace(router, ["tc", "qdisc", "add", "dev", device, "root", "netem", ...netem])
    } else if (rateMegabits !== undefined) {
      inNamespace(router, ["tc", "qdisc", "add", "dev", device, "root", "tbf", "rate", `${rateMegabits}mbit`, "burst", "64kb", "latency", "200ms"])
    }
  }
}

/** Drops everything the router would forward, as when a NAT forgets its connections; `false` restores it. */
export const blackhole = (side: LabSide, on: boolean) => {
  // Inserted first so it beats every other rule; deleting by its exact spec leaves udp-blocked's `-p udp` rule alone.
  // Removing is tolerant, so restoring twice (a timer, then clean-up) does no harm.
  inNamespace(routerNamespace(side), on ? ["iptables", "-I", "FORWARD", "1", "-j", "DROP"] : ["iptables", "-D", "FORWARD", "-j", "DROP"], !on)
}

/** Gives the router a new internet address and forgets its translations, as when a phone moves to another network. */
export const moveRouter = (side: LabSide, moved: boolean) => {
  const router = routerNamespace(side)
  inNamespace(router, ["ip", "addr", "flush", "dev", "wan"])
  inNamespace(router, ["ip", "addr", "add", `${wanAddress(side, moved)}/24`, "dev", "wan"])
  inNamespace(router, ["conntrack", "-F"], true)
}

/**
 * A wrapper executable that starts `executable` inside the side's home namespace, for Playwright's `executablePath`.
 * The browser keeps the pipes Playwright gave it, so Playwright drives it as usual.
 */
export const browserInHome = (side: LabSide, executable: string, directory: string): string => {
  const wrapper = nodePath.join(directory, `browser-in-home-${side}.sh`)
  writeFileSync(wrapper, `#!/bin/sh\nexec ip netns exec ${homeNamespace(side)} "${executable}" "$@"\n`)
  chmodSync(wrapper, 0o755)

  return wrapper
}
