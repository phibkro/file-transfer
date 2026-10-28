"""Runs the throughput matrix against one server process and prints one JSON line per run.

Usage: python3 clients/matrix.py <serverPid> <baseUrl> <totalMebibytes> <repetitions> <modes...>
The flow-control window is held at 2 MiB in bytes, so the window in frames shrinks as frames grow.
"""
import subprocess
import sys

server_pid, base_url, total, repetitions, *modes = sys.argv[1:]
window_kibibytes = 2048
for mode in modes:
    for frame_kibibytes in (16, 64, 256):
        window_frames = window_kibibytes // frame_kibibytes
        for _ in range(int(repetitions)):
            completed = subprocess.run(
                ["python3", "clients/measure.py", server_pid, base_url, mode, str(frame_kibibytes), total, str(window_frames)],
                capture_output=True,
                text=True,
                timeout=300,
            )
            print((completed.stdout or completed.stderr).strip(), flush=True)
