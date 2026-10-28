"""Runs one throughput client and records the server process's CPU seconds and resident memory around it.

Usage: python3 clients/measure.py <serverPid> <baseUrl> <mode> <frameKibibytes> <totalMebibytes> <windowFrames>
Server CPU and memory are for the whole workerd process (all objects, the Worker, and the runtime), so they are an
upper bound on what the Durable Object itself used.
"""
import json
import os
import resource
import subprocess
import sys
import threading
import time

server_pid = int(sys.argv[1])
arguments = sys.argv[2:]
ticks = os.sysconf("SC_CLK_TCK")


def server_cpu_seconds():
    with open(f"/proc/{server_pid}/stat") as stat:
        fields = stat.read().rsplit(")", 1)[1].split()
    return (int(fields[11]) + int(fields[12])) / ticks


def server_resident_mebibytes():
    with open(f"/proc/{server_pid}/status") as status:
        for line in status:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    return 0.0


peak_resident = server_resident_mebibytes()
resident_before = peak_resident
running = True


def sample():
    global peak_resident
    while running:
        peak_resident = max(peak_resident, server_resident_mebibytes())
        time.sleep(0.05)


sampler = threading.Thread(target=sample)
sampler.start()
cpu_before = server_cpu_seconds()
client_before = resource.getrusage(resource.RUSAGE_CHILDREN)
wall_before = time.time()
completed = subprocess.run(["bun", "clients/throughput.ts", *arguments], capture_output=True, text=True, env={**os.environ, "NO_PROXY": "127.0.0.1,localhost"})
wall = time.time() - wall_before
client_after = resource.getrusage(resource.RUSAGE_CHILDREN)
cpu_after = server_cpu_seconds()
running = False
sampler.join()

if completed.returncode != 0:
    print(json.dumps({"error": completed.stderr.strip()[-400:], "arguments": arguments}))
    sys.exit(1)
result = json.loads(completed.stdout.strip().splitlines()[-1])
result.update(
    {
        "serverCpuSeconds": round(cpu_after - cpu_before, 2),
        "serverCpuShareOfOneCore": round((cpu_after - cpu_before) / wall, 2),
        "clientCpuSeconds": round((client_after.ru_utime + client_after.ru_stime) - (client_before.ru_utime + client_before.ru_stime), 2),
        "serverResidentBeforeMebibytes": round(resident_before, 1),
        "serverResidentPeakMebibytes": round(peak_resident, 1),
    }
)
print(json.dumps(result))
