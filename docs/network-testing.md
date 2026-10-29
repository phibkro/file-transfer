# Testing on real networks

The automated suites cover what a machine can fake: seeded faults at the frame boundary (the chaos suite), NATs and impaired links in network namespaces (the lab suite), and two separate cloud machines (the two-machines workflow). They cannot fake phones, mobile carriers' shared NAT, corporate firewalls or Safari on iOS. This checklist is for those, run by a person with two devices.

## How to run one

1. Open the site on the sending device, add a file, and send the link to the receiving device (any messenger; never paste the link anywhere public).
2. Accept on the receiving device and let it finish.
3. On **both** devices, press **Copy report** under the summary and paste both reports into the matrix below (or an issue titled "network report"). A report holds sizes, times, the path and the browser, never a file name or the link.

What the report lines mean:

| Line          | Meaning                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `speed`       | Bytes over time, from the first record to completion                                                    |
| `reconnects`  | How often this side's socket to the room dropped and rejoined                                           |
| `path`        | `direct between browsers` if any record went directly, else `through the server's relay`                |
| `direct path` | When the direct path opened after the transfer started, and how often it dropped back to the relay      |
| `network`     | What the browser reports about its connection (Chromium-based browsers only; others say "not reported") |

## The matrix

Each row is one transfer; 100 MB or more, so the direct path has time to open and the speed means something. A few rows at 1 GB catch what only long transfers show.

| Sender                                                | Recipient                        | Why it matters                                        |
| ----------------------------------------------------- | -------------------------------- | ----------------------------------------------------- |
| Laptop, home Wi-Fi                                    | Phone, same Wi-Fi                | The easy case; should go direct within seconds        |
| Laptop, home Wi-Fi                                    | Phone, mobile data               | Carrier NAT; often blocks the direct path             |
| Phone, mobile data                                    | Laptop, another home's broadband | Upload from a phone, the slowest common link          |
| Laptop, corporate Wi-Fi                               | Laptop, home                     | Firewalls that block UDP: must fall back to the relay |
| Laptop                                                | iPhone, Safari                   | Safari's storage and data channel behave differently  |
| Laptop                                                | Android, Chrome                  | The only browser that reports the network type        |
| Either, then switch networks mid-transfer (Wi-Fi off) | the other                        | The heartbeat must notice, rejoin and resume          |
| Either, then lock the phone for a minute mid-transfer | the other                        | Background tabs are throttled or suspended            |

Paste reports under the row they belong to:

```text
(paste the sender's and the recipient's reports here)
```
