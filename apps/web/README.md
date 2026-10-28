# apps/web

The user interface: drop zone, share link, progress on both sides, landing page, fake doors for paid features, `/abuse` notice form. Built on `libraries/client`, bundled with Vite, and served as static assets by every platform. Built in M2 and M3; the M0 spike harness pages live in `spikes/`.

Security rules for this app: strict Content Security Policy, no third-party scripts, never send `location.hash` anywhere, reproducible builds with published hashes.
