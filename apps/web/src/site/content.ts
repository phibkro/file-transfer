import type { Html, HtmlBuilder } from "foldkit/html"

export const howItWorks = (h: HtmlBuilder<never>): Html =>
  h.main(
    [h.Attribute("class", "content")],
    [
      h.div(
        [h.Class("doc-hero")],
        [
          "\n      ",
          h.h1([], ["How it works"]),
          "\n      ",
          h.p(
            [h.Attribute("class", "lead")],
            [
              "\n        You pick files and your browser encrypts them. You share a link. The recipient's browser downloads every piece, checks it, and decrypts it. The server\n        in the middle passes encrypted pieces along and never holds a key.\n      ",
            ],
          ),
        ],
      ),
      h.article(
        [h.Class("doc-body panel")],
        [
          "\n\n      ",
          h.h2([], ["One transfer"]),
          "\n      ",
          h.figure(
            [h.Attribute("class", "diagram")],
            [
              "\n        ",
              h.svg(
                [h.Attribute("viewBox", "0 0 640 400"), h.Attribute("role", "img"), h.Attribute("aria-labelledby", "flow-title flow-description")],
                [
                  "\n          ",
                  h.title([h.Attribute("id", "flow-title")], ["One transfer"]),
                  "\n          ",
                  h.desc(
                    [h.Attribute("id", "flow-description")],
                    [
                      "\n            The sender's browser encrypts the files. Encrypted pieces go to the recipient's browser, directly when the two can connect and through the relay\n            otherwise; the recipient checks and decrypts them. The key travels only inside the link, from sender to recipient, never through the server.\n          ",
                    ],
                  ),
                  "\n          ",
                  h.defs(
                    [],
                    [
                      "\n            ",
                      h.marker(
                        [
                          h.Attribute("id", "arrow"),
                          h.Attribute("viewBox", "0 0 10 10"),
                          h.Attribute("refX", "9"),
                          h.Attribute("refY", "5"),
                          h.Attribute("markerWidth", "7"),
                          h.Attribute("markerHeight", "7"),
                          h.Attribute("orient", "auto-start-reverse"),
                        ],
                        ["\n              ", h.path([h.Attribute("d", "M 0 0 L 10 5 L 0 10 z"), h.Attribute("class", "diagram-arrowhead")]), "\n            "],
                      ),
                      "\n          ",
                    ],
                  ),
                  "\n          ",
                  h.rect([
                    h.Attribute("x", "40"),
                    h.Attribute("y", "16"),
                    h.Attribute("width", "320"),
                    h.Attribute("height", "76"),
                    h.Attribute("rx", "10"),
                    h.Attribute("class", "diagram-box"),
                  ]),
                  "\n          ",
                  h.text([h.Attribute("x", "200"), h.Attribute("y", "46"), h.Attribute("class", "diagram-title")], ["Sender's browser"]),
                  "\n          ",
                  h.text([h.Attribute("x", "200"), h.Attribute("y", "70"), h.Attribute("class", "diagram-text")], ["encrypts files and names"]),
                  "\n          ",
                  h.rect([
                    h.Attribute("x", "40"),
                    h.Attribute("y", "162"),
                    h.Attribute("width", "320"),
                    h.Attribute("height", "76"),
                    h.Attribute("rx", "10"),
                    h.Attribute("class", "diagram-box diagram-server"),
                  ]),
                  "\n          ",
                  h.text([h.Attribute("x", "200"), h.Attribute("y", "192"), h.Attribute("class", "diagram-title")], ["Relay (the server)"]),
                  "\n          ",
                  h.text([h.Attribute("x", "200"), h.Attribute("y", "216"), h.Attribute("class", "diagram-text")], ["passes ciphertext, holds no key"]),
                  "\n          ",
                  h.rect([
                    h.Attribute("x", "40"),
                    h.Attribute("y", "308"),
                    h.Attribute("width", "320"),
                    h.Attribute("height", "76"),
                    h.Attribute("rx", "10"),
                    h.Attribute("class", "diagram-box"),
                  ]),
                  "\n          ",
                  h.text([h.Attribute("x", "200"), h.Attribute("y", "338"), h.Attribute("class", "diagram-title")], ["Recipient's browser"]),
                  "\n          ",
                  h.text([h.Attribute("x", "200"), h.Attribute("y", "362"), h.Attribute("class", "diagram-text")], ["checks every piece, decrypts"]),
                  "\n          ",
                  h.line([
                    h.Attribute("x1", "200"),
                    h.Attribute("y1", "92"),
                    h.Attribute("x2", "200"),
                    h.Attribute("y2", "158"),
                    h.Attribute("class", "diagram-line"),
                    h.Attribute("marker-end", "url(#arrow)"),
                  ]),
                  "\n          ",
                  h.text([h.Attribute("x", "212"), h.Attribute("y", "130"), h.Attribute("class", "diagram-label diagram-left")], ["encrypted pieces"]),
                  "\n          ",
                  h.line([
                    h.Attribute("x1", "200"),
                    h.Attribute("y1", "238"),
                    h.Attribute("x2", "200"),
                    h.Attribute("y2", "304"),
                    h.Attribute("class", "diagram-line"),
                    h.Attribute("marker-end", "url(#arrow)"),
                  ]),
                  "\n          ",
                  h.text([h.Attribute("x", "212"), h.Attribute("y", "276"), h.Attribute("class", "diagram-label diagram-left")], ["encrypted pieces"]),
                  "\n          ",
                  h.path([
                    h.Attribute("d", "M 360 54 H 520 V 346 H 364"),
                    h.Attribute("class", "diagram-line diagram-key"),
                    h.Attribute("marker-end", "url(#arrow)"),
                  ]),
                  "\n          ",
                  h.text([h.Attribute("x", "532"), h.Attribute("y", "186"), h.Attribute("class", "diagram-label diagram-left")], ["the link"]),
                  "\n          ",
                  h.text([h.Attribute("x", "532"), h.Attribute("y", "206"), h.Attribute("class", "diagram-label diagram-left")], ["(key after #)"]),
                  "\n        ",
                ],
              ),
              "\n        ",
              h.figcaption([], ["The key travels only inside the link, which you share yourself. It never passes through the server."]),
              "\n      ",
            ],
          ),
          "\n\n      ",
          h.ol(
            [h.Attribute("class", "steps")],
            [
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Sealing."]),
                  " Your browser makes a random 32-byte secret, derives keys from it, and encrypts the files and their names into a\n          ",
                  h.em([], ["parcel"]),
                  ", a format specified in the open (",
                  h.a([h.Attribute("href", "https://github.com/phibkro/file-transfer/blob/main/docs/parcel.md")], ["parcel v1"]),
                  ").\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["The link."]),
                  " The secret goes in the part of the link after ",
                  h.code([], ["#"]),
                  ". Browsers never send that part to any server. You share the\n          link however you like: copy it, use your phone's share sheet, or show a QR code.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["The room."]),
                  " The server opens a room that admits only a browser that proves it holds the link. It stores a hash of a token derived from\n          the secret, never the secret.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Review."]),
                  " The recipient's browser decrypts the list of files and shows names and sizes. Nothing downloads until the recipient accepts.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Transfer."]),
                  " Encrypted pieces flow through the room. Before any content, the recipient receives a fingerprint of every piece, and checks\n          each piece against it as it arrives. If either side loses its connection, the transfer resumes where it stopped.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  h.strong([], ["Done."]),
                  " Files appear only once every piece has checked out. They stay in your browser until you save them or leave the page.",
                ],
              ),
              "\n      ",
            ],
          ),
          "\n\n      ",
          h.h2([], ["What the server sees, and what it never sees"]),
          "\n      ",
          h.div(
            [h.Attribute("class", "table-wrap")],
            [
              "\n        ",
              h.table(
                [],
                [
                  "\n          ",
                  h.thead(
                    [],
                    [
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.th([h.Attribute("scope", "col")], ["Never"]),
                          "\n              ",
                          h.th([h.Attribute("scope", "col")], ["Sees"]),
                          "\n            ",
                        ],
                      ),
                      "\n          ",
                    ],
                  ),
                  "\n          ",
                  h.tbody(
                    [],
                    [
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], ["What is in your files"]),
                          "\n              ",
                          h.td([], ["That a room exists, and when it is used"]),
                          "\n            ",
                        ],
                      ),
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], ["File names, types, and how many files (beyond a rough bucket)"]),
                          "\n              ",
                          h.td([], ["The total size of the encrypted parcel, and how fast it moves"]),
                          "\n            ",
                        ],
                      ),
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], ["The link's secret, or any key"]),
                          "\n              ",
                          h.td([], ["The network addresses of connected browsers, as any server does"]),
                          "\n            ",
                        ],
                      ),
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], ["Your saved files"]),
                          "\n              ",
                          h.td([], ["Counts for the operator: rooms, completed and failed transfers, bytes relayed"]),
                          "\n            ",
                        ],
                      ),
                      "\n          ",
                    ],
                  ),
                  "\n        ",
                ],
              ),
              "\n      ",
            ],
          ),
          "\n      ",
          h.p(
            [],
            [
              "\n        For limits, the server keeps a salted hash of a network address for one hour, never the address itself. The full list of what a server keeps is on the\n        ",
              h.a([h.Attribute("href", "/privacy")], ["privacy page"]),
              ".\n      ",
            ],
          ),
          "\n\n      ",
          h.h2([], ["Today, and what comes next"]),
          "\n      ",
          h.ul(
            [],
            [
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Direct when possible."]),
                  " When both browsers allow it and the network lets them, encrypted pieces go directly between them (WebRTC).\n          Otherwise, or when a direct connection drops, they go through the server's relay, and the transfer carries on from where it was. Either way they are\n          encrypted end to end. A direct connection shows each side the other's network address; see ",
                  h.a([h.Attribute("href", "/privacy")], ["privacy"]),
                  ".\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["No files on servers."]),
                  " A room holds a token hash and a byte count, and is deleted a day after everyone leaves. Encrypted storage for\n          recipients who are offline is a later, opt-in feature.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Large files."]),
                  " Transfers of 10 GB have been tested from end to end. Instances with the default settings relay up to 25 GB per transfer.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  h.strong([], ["Anyone can run it."]),
                  " The software is free under the AGPL. See ",
                  h.a([h.Attribute("href", "/run-your-own")], ["run your own"]),
                  ".",
                ],
              ),
              "\n      ",
            ],
          ),
          "\n    ",
        ],
      ),
    ],
  )

export const security = (h: HtmlBuilder<never>): Html =>
  h.main(
    [h.Attribute("class", "content")],
    [
      h.div(
        [h.Class("doc-hero")],
        [
          "\n      ",
          h.h1([], ["Security"]),
          "\n      ",
          h.p([h.Attribute("class", "lead")], ["What protects your files, what it does not protect against, and how to help find and fix problems."]),
        ],
      ),
      h.article(
        [h.Class("doc-body panel")],
        [
          "\n\n      ",
          h.h2([], ["What protects your files"]),
          "\n      ",
          h.ul(
            [],
            [
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Encryption happens in your browser."]),
                  " Files and names are encrypted with AES-256-GCM through the browser's built-in Web Crypto. Keys\n          come from HKDF-SHA-256 over a 32-byte random secret. Nonces are derived from the content (synthetic), so they never repeat, and a parcel opens under\n          exactly one key (key commitment).\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["The key stays in the link."]),
                  " The secret lives after the ",
                  h.code([], ["#"]),
                  " in the link, which browsers never send to servers. Servers store\n          only a hash of a token derived from it, which admits a browser to the room and cannot decrypt anything.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Every piece is checked."]),
                  " Before any content, the recipient receives a SHA-256 hash tree over every encrypted piece. Missing,\n          reordered, swapped or altered pieces stop the transfer, and so does a file that changed on the sender's side partway through.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [h.strong([], ["You see the offer first."]), " Names and sizes are shown before anything downloads, and nothing downloads until you accept."],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Previews run in a sandbox."]),
                  " Previews render in a frame with no access to this site's storage or links, and only for formats recognised\n          from a file's own bytes. HTML and SVG are never rendered as pages.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["A strict page."]),
                  " A content security policy blocks code from anywhere but this site. There are no third-party scripts, no analytics and\n          no cookies.\n        ",
                ],
              ),
              "\n      ",
            ],
          ),
          "\n\n      ",
          h.h2([], ["What it does not protect against"]),
          "\n      ",
          h.ul(
            [],
            [
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Anyone with the link can receive the files."]),
                  " Share it only with your recipient. A room admits one recipient at a time, and a newer\n          connection holding the link replaces an older one.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["The code your browser runs comes from the server."]),
                  " A malicious or compromised server could serve code that leaks keys. That is true of\n          every encrypted web app. What limits it: the code is open, you can run your own instance, and reproducible builds and browser-verified code are\n          planned.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  h.strong([], ["Metadata."]),
                  " The server sees sizes, timing and network addresses (see ",
                  h.a([h.Attribute("href", "/how-it-works")], ["how it works"]),
                  ").",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Your own devices."]),
                  " Malware on the sender's or the recipient's device defeats any encryption. Received files are decrypted in your\n          browser's storage until you leave the page.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["No human cryptographer has audited it yet."]),
                  " The parcel format was reviewed in two passes by an AI reviewer and is checked against an\n          independent implementation in every build. A human review is planned before a 1.0 release; a flaw found then is fixed in a new format version.\n        ",
                ],
              ),
              "\n      ",
            ],
          ),
          "\n\n      ",
          h.h2([h.Attribute("id", "report")], ["Find problems, and help fix them"]),
          "\n      ",
          h.ul(
            [],
            [
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Everything is public:"]),
                  " the ",
                  h.a([h.Attribute("href", "https://github.com/phibkro/file-transfer")], ["code"]),
                  ", the\n          ",
                  h.a([h.Attribute("href", "https://github.com/phibkro/file-transfer/blob/main/docs/parcel.md")], ["format specification"]),
                  ", its test vectors and the design decisions.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Point any tool at it, including AI agents."]),
                  " Fuzz the format, review the code, or attack an instance ",
                  h.em([], ["you run yourself"]),
                  ". Please\n          do not test instances that other people run, this one included, beyond normal use.\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Report vulnerabilities privately"]),
                  " through the repository's\n          ",
                  h.a([h.Attribute("href", "https://github.com/phibkro/file-transfer/security")], ["security page"]),
                  " (Report a vulnerability). The policy is in\n          ",
                  h.a([h.Attribute("href", "https://github.com/phibkro/file-transfer/blob/main/SECURITY.md")], ["SECURITY.md"]),
                  ".\n        ",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.strong([], ["Fixes are welcome"]),
                  " as pull requests. Changes to the parcel format need test vectors and new version numbers, never edits to a frozen\n          version.\n        ",
                ],
              ),
              "\n      ",
            ],
          ),
          "\n    ",
        ],
      ),
    ],
  )

export const privacy = (h: HtmlBuilder<never>): Html =>
  h.main(
    [h.Attribute("class", "content")],
    [
      h.div(
        [h.Class("doc-hero")],
        [
          "\n      ",
          h.h1([], ["Privacy"]),
          "\n      ",
          h.p(
            [h.Attribute("class", "lead")],
            [
              "\n        This software is built to know as little as possible about you and your files. This page describes the software as published. Anyone may run their own\n        instance, possibly modified, and its operator is responsible for it.\n      ",
            ],
          ),
        ],
      ),
      h.article(
        [h.Class("doc-body panel")],
        [
          "\n\n      ",
          h.h2([], ["Never stored on a server"]),
          "\n      ",
          h.ul(
            [],
            [
              "\n        ",
              h.li([], ["Your files, in any form, encrypted or not."]),
              "\n        ",
              h.li([], ["File names, types or counts."]),
              "\n        ",
              h.li([], ["The link, its secret, or any key."]),
              "\n      ",
            ],
          ),
          "\n\n      ",
          h.h2([], ["What a server keeps, and for how long"]),
          "\n      ",
          h.div(
            [h.Attribute("class", "table-wrap")],
            [
              "\n        ",
              h.table(
                [],
                [
                  "\n          ",
                  h.thead(
                    [],
                    [
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.th([h.Attribute("scope", "col")], ["What"]),
                          "\n              ",
                          h.th([h.Attribute("scope", "col")], ["Why"]),
                          "\n              ",
                          h.th([h.Attribute("scope", "col")], ["Kept until"]),
                          "\n            ",
                        ],
                      ),
                      "\n          ",
                    ],
                  ),
                  "\n          ",
                  h.tbody(
                    [],
                    [
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], ["A room: a hash of its room token, how many recipients it admits, and how many bytes it relayed"]),
                          "\n              ",
                          h.td([], ["To admit only browsers holding the link, and to apply the operator's relay limit"]),
                          "\n              ",
                          h.td([], ["A day after everyone leaves the room"]),
                          "\n            ",
                        ],
                      ),
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], ["A salted hash of your network address, with a count of rooms created"]),
                          "\n              ",
                          h.td([], ["To limit how many transfers one network starts per hour"]),
                          "\n              ",
                          h.td([], ["The end of that hour"]),
                          "\n            ",
                        ],
                      ),
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td(
                            [],
                            [
                              "\n                Only if the operator turns counting on: counts per hour of rooms, recipients, completed and failed transfers, size buckets and megabytes\n                relayed, with nothing that identifies anyone\n              ",
                            ],
                          ),
                          "\n              ",
                          h.td([], ["So the operator can see that the service works"]),
                          "\n              ",
                          h.td([], ["90 days by default, set by the operator"]),
                          "\n            ",
                        ],
                      ),
                      "\n          ",
                    ],
                  ),
                  "\n        ",
                ],
              ),
              "\n      ",
            ],
          ),
          "\n      ",
          h.p(
            [],
            [
              "\n        The hosting provider may keep its own request logs under its own terms. Those logs can include network addresses and room identifiers, never the part of\n        the link after ",
              h.code([], ["#"]),
              ". On Cloudflare, this software turns off the Worker's own request logging.\n      ",
            ],
          ),
          "\n\n      ",
          h.h2([], ["Direct connections and your network address"]),
          "\n      ",
          h.p(
            [],
            [
              "When both sides allow direct connections, encrypted pieces travel between browsers through WebRTC. Browsers exchange network addresses through the room and can contact the operator's configured STUN service. The other endpoint learns your network (IP) address. To prevent that disclosure, open Settings, then Direct connections, and switch direct connections off. Transfers you start or open afterwards use the relay. The relay still sees your network address.",
            ],
          ),
          "\n\n      ",
          h.h2([], ["In your browser"]),
          "\n      ",
          h.ul(
            [],
            [
              "\n        ",
              h.li(
                [],
                [
                  "Received files stay in this site's private browser storage until you remove them or leave the page. A later visit deletes abandoned received files.",
                ],
              ),
              "\n        ",
              h.li([], ["Settings contains Storage in this browser. This panel shows storage use and controls for clearing received output."]),
              "\n        ",
              h.li([], ["Whether you allow direct connections is remembered in this browser only."]),
              h.li(
                [],
                [
                  "Local Library remembering starts off. Opting in stores names, sizes, fingerprints, collection membership and supported file handles on this device. Indexing does not upload or copy file contents.",
                ],
              ),
              h.li([], ["Turning Library remembering off forgets catalog metadata and named collections, not original files. My files remains available."]),
              "\n        ",
              h.li([], ["This software sets no cookies. A hosting provider's bot protection may set its own (Cloudflare's challenge page does)."]),
              "\n      ",
            ],
          ),
          "\n\n      ",
          h.h2([], ["No tracking"]),
          "\n      ",
          h.ul(
            [],
            [
              "\n        ",
              h.li([], ["No analytics, no advertising, no third-party scripts or fonts."]),
              "\n        ",
              h.li([], ["Nothing is sent to the people who make this software. An instance never phones home."]),
              "\n        ",
              h.li([], ["Counting is off unless the operator turns it on. Any instance tells you whether it counts at ", h.code([], ["/api/instance"]), "."]),
              "\n      ",
            ],
          ),
          "\n    ",
        ],
      ),
    ],
  )

export const runYourOwn = (h: HtmlBuilder<never>): Html =>
  h.main(
    [h.Attribute("class", "content")],
    [
      h.div(
        [h.Class("doc-hero")],
        [
          "\n      ",
          h.h1([], ["Run your own"]),
          "\n      ",
          h.p(
            [h.Attribute("class", "lead")],
            [
              "\n        The whole system is free software under the AGPL-3.0. Run a private instance for yourself, your family or your team, with your own limits.\n      ",
            ],
          ),
        ],
      ),
      h.article(
        [h.Class("doc-body panel")],
        [
          "\n\n      ",
          h.h2([], ["On your own Cloudflare account"]),
          "\n      ",
          h.p(
            [],
            [
              "\n        This works today. Cloudflare's free plan is enough for personal use: by our estimate from Cloudflare's published limits, a free account relays on the\n        order of 100 GB a day. Cloudflare does not charge for bandwidth.\n      ",
            ],
          ),
          "\n      ",
          h.ol(
            [h.Attribute("class", "steps")],
            [
              "\n        ",
              h.li(
                [],
                [
                  "Install ",
                  h.a([h.Attribute("href", "https://bun.sh")], ["Bun"]),
                  " 1.4 or later, and sign in to Cloudflare with ",
                  h.code([], ["bunx wrangler login"]),
                  ".",
                ],
              ),
              "\n        ",
              h.li(
                [],
                [
                  "\n          Get the code and build it:\n          ",
                  h.pre(
                    [],
                    [
                      h.code(
                        [],
                        [
                          "git clone https://github.com/phibkro/file-transfer\n      cd file-transfer\n      bun install\n      cd platforms/cloudflare\n      bun run build:all",
                        ],
                      ),
                    ],
                  ),
                  "\n        ",
                ],
              ),
              "\n        ",
              h.li([], ["Deploy: ", h.code([], ["bunx wrangler deploy"]), ". Wrangler prints your instance's address on ", h.code([], ["workers.dev"]), "."]),
              "\n        ",
              h.li(
                [],
                [
                  "\n          Optionally, attach your own domain in the Cloudflare dashboard. The salt that keeps address hashes from being reversed is generated on first use;\n          there is nothing to set.\n        ",
                ],
              ),
              "\n      ",
            ],
          ),
          "\n\n      ",
          h.h2([], ["One-click deploy"]),
          "\n      ",
          h.p(
            [],
            [
              "\n        ",
              h.a(
                [
                  h.Attribute("class", "button-link"),
                  h.Attribute("href", "https://deploy.workers.cloudflare.com/?url=https://github.com/phibkro/file-transfer/tree/deploy"),
                ],
                ["Deploy to Cloudflare"],
              ),
              "\n      ",
            ],
          ),
          "\n      ",
          h.p(
            [],
            [
              "\n        Cloudflare copies a prebuilt version of this software into a new repository in your GitHub account and deploys it to your account, without installing\n        anything. It asks for one optional secret, an admin token for the operator page; everything else has a default. The\n        ",
              h.a([h.Attribute("href", "https://github.com/phibkro/file-transfer/tree/deploy")], ["deploy branch"]),
              " it copies is built by CI from the main branch.\n      ",
            ],
          ),
          "\n\n      ",
          h.h2([], ["On your own machine"]),
          "\n      ",
          h.p(
            [],
            ["The same server code runs on workerd, Cloudflare's open-source runtime, in one container. Any machine or provider that runs Docker will do:"],
          ),
          "\n      ",
          h.pre([], [h.code([], ["docker run -p 8080:8080 -v file-transfer-storage:/srv/storage ghcr.io/phibkro/file-transfer"])]),
          "\n      ",
          h.p(
            [],
            [
              "\n        Put a proxy that terminates TLS in front of it (Caddy, Traefik or nginx), because browsers allow the encryption and storage this app needs only on\n        HTTPS. Set ",
              h.code([], ["CLIENT_ADDRESS_HEADER"]),
              " to the header your proxy writes the client's address into, for example ",
              h.code([], ["x-real-ip"]),
              ". The\n        settings below are environment variables there; the\n        ",
              h.a([h.Attribute("href", "https://github.com/phibkro/file-transfer/tree/main/platforms/self-hosted")], ["self-hosting guide"]),
              " has the details.\n      ",
            ],
          ),
          "\n\n      ",
          h.h2([], ["As one program"]),
          "\n      ",
          h.p(
            [],
            [
              "\n        Without Docker, download ",
              h.code([], ["file-transfer-node"]),
              " for Linux (x64 or arm64), macOS (Apple silicon or Intel) or Windows from the\n        ",
              h.a([h.Attribute("href", "https://github.com/phibkro/file-transfer/releases")], ["releases page"]),
              ". It is the same server with the web app built in, in one file:\n      ",
            ],
          ),
          "\n      ",
          h.pre([], [h.code([], ["mkdir storage\n./file-transfer-node"])]),
          "\n      ",
          h.p(
            [],
            [
              "\n        It listens on port 8080 and keeps room state in ",
              h.code([], ["./storage"]),
              "; ",
              h.code([], ["--socket-addr http=127.0.0.1:9000"]),
              " and\n        ",
              h.code([], ["--directory-path storage=/var/lib/file-transfer"]),
              " change them. Put the same TLS proxy in front, and set the same environment variables.\n      ",
            ],
          ),
          "\n\n      ",
          h.h2([], ["Limits you control"]),
          "\n      ",
          h.div(
            [h.Attribute("class", "table-wrap")],
            [
              "\n        ",
              h.table(
                [],
                [
                  "\n          ",
                  h.thead(
                    [],
                    [
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.th([h.Attribute("scope", "col")], ["Variable"]),
                          "\n              ",
                          h.th([h.Attribute("scope", "col")], ["Default"]),
                          "\n              ",
                          h.th([h.Attribute("scope", "col")], ["What it limits"]),
                          "\n            ",
                        ],
                      ),
                      "\n          ",
                    ],
                  ),
                  "\n          ",
                  h.tbody(
                    [],
                    [
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], [h.code([], ["LIMIT_ROOMS_PER_ADDRESS_PER_HOUR"])]),
                          "\n              ",
                          h.td([], ["50"]),
                          "\n              ",
                          h.td([], ["Transfers one network address may start per hour"]),
                          "\n            ",
                        ],
                      ),
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], [h.code([], ["LIMIT_RELAYED_BYTES_PER_ROOM"])]),
                          "\n              ",
                          h.td([], ["25000000000 (25 GB)"]),
                          "\n              ",
                          h.td([], ["Bytes relayed for one transfer"]),
                          "\n            ",
                        ],
                      ),
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], [h.code([], ["LIMIT_RELAYED_BYTES_PER_DAY"])]),
                          "\n              ",
                          h.td([], ["100000000000 (100 GB) on Cloudflare; off in the container"]),
                          "\n              ",
                          h.td([], ["Bytes the whole instance relays per day (UTC); ", h.code([], ["off"]), " for no daily budget"]),
                          "\n            ",
                        ],
                      ),
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], [h.code([], ["DIRECT_CONNECTIONS"])]),
                          "\n              ",
                          h.td([], ["on"]),
                          "\n              ",
                          h.td([], ["Whether browsers may connect directly; ", h.code([], ["off"]), " keeps every transfer on your relay"]),
                          "\n            ",
                        ],
                      ),
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], [h.code([], ["STUN_URLS"])]),
                          "\n              ",
                          h.td([], [h.code([], ["stun:stun.cloudflare.com:3478"])]),
                          "\n              ",
                          h.td([], ["STUN servers that tell browsers their public address, for direct connections; ", h.code([], ["none"]), " for none"]),
                          "\n            ",
                        ],
                      ),
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], [h.code([], ["CLIENT_ADDRESS_HEADER"])]),
                          "\n              ",
                          h.td([], [h.code([], ["cf-connecting-ip"])]),
                          "\n              ",
                          h.td([], ["Where the client's address comes from; change it only behind your own proxy"]),
                          "\n            ",
                        ],
                      ),
                      "\n          ",
                    ],
                  ),
                  "\n        ",
                ],
              ),
              "\n      ",
            ],
          ),
          "\n      ",
          h.p(
            [],
            [
              "\n        On Cloudflare, set them in ",
              h.code([], ["platforms/cloudflare/wrangler.jsonc"]),
              " before deploying, or in the dashboard afterwards. In the container, pass\n        them as environment variables (",
              h.code([], ["docker run -e COUNTERS=on ..."]),
              ").\n      ",
            ],
          ),
          "\n\n      ",
          h.h2([], ["What Cloudflare's free plan carries"]),
          "\n      ",
          h.p(
            [],
            [
              "\n        Cloudflare charges nothing for bandwidth. It bills the relay by Durable Object requests, counting 20 incoming WebSocket messages as one, and by the time\n        a room is busy. Only relayed transfers count: one that goes directly between browsers costs a handful of requests, and the figures below assume every\n        transfer is relayed. The free plan's daily allowance is shared by everyone using your instance, and by any other Workers in the same Cloudflare account.\n        These are estimates from Cloudflare's list prices and our\n        ",
              h.a([h.Attribute("href", "https://github.com/phibkro/file-transfer/blob/main/docs/spikes/0003-relay-load.md")], ["load test"]),
              ", not from an invoice:\n      ",
            ],
          ),
          "\n      ",
          h.div(
            [h.Attribute("class", "table-wrap")],
            [
              "\n        ",
              h.table(
                [],
                [
                  "\n          ",
                  h.thead(
                    [],
                    [
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.th([h.Attribute("scope", "col")], ["Per day on Workers Free"]),
                          "\n              ",
                          h.th([h.Attribute("scope", "col")], ["About"]),
                          "\n            ",
                        ],
                      ),
                      "\n          ",
                    ],
                  ),
                  "\n          ",
                  h.tbody(
                    [],
                    [
                      "\n            ",
                      h.tr(
                        [],
                        ["\n              ", h.td([], ["Durable Object requests included"]), "\n              ", h.td([], ["100,000"]), "\n            "],
                      ),
                      "\n            ",
                      h.tr([], ["\n              ", h.td([], ["Requests per GB relayed"]), "\n              ", h.td([], ["775"]), "\n            "]),
                      "\n            ",
                      h.tr([], ["\n              ", h.td([], ["Relayed in total"]), "\n              ", h.td([], ["125 GB"]), "\n            "]),
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], ["Full-size transfers at the defaults"]),
                          "\n              ",
                          h.td([], ["5 of 25 GB, or 12 of 10 GB, or 1,200 of 100 MB"]),
                          "\n            ",
                        ],
                      ),
                      "\n            ",
                      h.tr(
                        [],
                        [
                          "\n              ",
                          h.td([], ["Time rooms are busy (13,000 GB-s)"]),
                          "\n              ",
                          h.td([], ["Runs out first only if transfers average below about 1 MB/s"]),
                          "\n            ",
                        ],
                      ),
                      "\n          ",
                    ],
                  ),
                  "\n        ",
                ],
              ),
              "\n      ",
            ],
          ),
          "\n      ",
          h.p(
            [],
            [
              "\n        When the day's requests are used up, transfers on your instance stop until the allowance resets, for everyone: new ones cannot start, and ones in\n        progress stop. The per-address limits cannot prevent this, because five full-size transfers from one person are enough. So Cloudflare deploys come with\n        a daily relay budget of 100 GB for the whole instance: past it, transfers stop with a message and new ones are refused until midnight UTC, and your\n        account keeps requests for everything else. On Workers Paid, raise ",
              h.code([], ["LIMIT_RELAYED_BYTES_PER_DAY"]),
              " or set it to ",
              h.code([], ["off"]),
              ". On Workers\n        Paid ($5 a month), the included million requests relay about 1,300 GB a month, and more costs roughly $0.17 to $0.64 per TB. Running it on your own\n        machine has no such allowance: the limit is your connection.\n      ",
            ],
          ),
          "\n\n      ",
          h.h2([], ["Counters, if you want them"]),
          "\n      ",
          h.p(
            [],
            [
              "\n        Counting is off by default. Set ",
              h.code([], ["COUNTERS"]),
              " to ",
              h.code([], ["on"]),
              " to keep hourly counts of rooms, recipients, completed and failed transfers,\n        size buckets and megabytes relayed, with nothing that identifies anyone (kept for ",
              h.code([], ["COUNTERS_RETENTION_DAYS"]),
              ", 90 by default). Then set an\n        admin token, ",
              h.code([], ["bunx wrangler secret put ADMIN_TOKEN"]),
              ", and read them:\n      ",
            ],
          ),
          "\n      ",
          h.ul(
            [],
            [
              "\n        ",
              h.li([], [h.code([], ["/admin"]), ": a page with your settings, a 48-hour chart and the totals."]),
              "\n        ",
              h.li([], [h.code([], ["/api/admin/counters"]), ": totals and hourly counts as JSON."]),
              "\n        ",
              h.li(
                [],
                [
                  "\n          ",
                  h.code([], ["/api/admin/metrics"]),
                  ": totals in OpenMetrics, which Prometheus and Grafana read. Scrape it with\n          ",
                  h.code([], ["authorization: Bearer <your token>"]),
                  ".\n        ",
                ],
              ),
              "\n      ",
            ],
          ),
          "\n      ",
          h.p(
            [],
            ["Without an admin token those addresses do not exist. Visitors can see whether your instance counts at ", h.code([], ["/api/instance"]), "."],
          ),
          "\n\n      ",
          h.h2([], ["If you change the code"]),
          "\n      ",
          h.p(
            [],
            [
              '\n        The AGPL asks you to offer the source of your modified version to the people who use your instance. Point the "Source code" link at your repository\n        (',
              h.code([], ["sourceUrl"]),
              " in ",
              h.code([], ["apps/web/src/site/layout.ts"]),
              ").\n      ",
            ],
          ),
          "\n    ",
        ],
      ),
    ],
  )
