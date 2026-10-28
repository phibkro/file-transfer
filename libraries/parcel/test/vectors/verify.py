"""
Independent check of the parcel v1 test vectors, written from docs/parcel.md alone (no code shared with the
TypeScript implementation) on pyca/cryptography (OpenSSL) and Python's own Unicode data instead of Web Crypto.

It re-derives every secret and key, reseals every record, recomputes labels, pages, the root and the contract digest
byte for byte, then opens each parcel with its own receiver and checks the plaintext. Every rejection vector must be
rejected with the expected reason.

Run: python3 -I libraries/parcel/test/vectors/verify.py   (needs: pip install cryptography; Python 3.13 for Unicode 15.1)
"""

import base64
import hashlib
import hmac
import json
import pathlib
import re
import struct
import sys
import unicodedata

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAGIC = bytes([0x45, 0x32, 0x45, 0x01])
HEADER_LENGTH = 58
MANIFEST_RECORD = 4096
OVERHEAD = 7 + 16
PREFIX = 8 + 32 + 4
PAGE = 1024
SIZE_LIMIT = 2**40
JSON_LIMIT = 2**24 - PREFIX
FORBIDDEN_CATEGORIES = {"Cc", "Cf", "Zl", "Zp", "Cs"}
FORBIDDEN_ASCII = set('\\:*?"<>|')
RESTRICTED = "[a-z0-9][a-z0-9!#$&^_.+-]{0,126}"
MEDIA_TYPE = re.compile(f"^{RESTRICTED}/{RESTRICTED}$")


class Rejected(Exception):
    def __init__(self, reason: str, message: str = ""):
        super().__init__(f"{reason}: {message}")
        self.reason = reason


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def expand(ikm: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=b"parcel/v1", info=info).derive(ikm)


def parcel_secret(link_secret: bytes, sequence: int) -> bytes:
    return expand(link_secret, b"parcel/v1/parcel-secret" + struct.pack(">I", sequence))


def parcel_keys(secret: bytes, salt: bytes) -> dict:
    return {
        "content": (expand(secret, b"parcel/v1/content-key" + salt), expand(secret, b"parcel/v1/content-synthetic-key" + salt)),
        "manifest": (expand(secret, b"parcel/v1/manifest-key" + salt), expand(secret, b"parcel/v1/manifest-synthetic-key" + salt)),
        "commitment": expand(secret, b"parcel/v1/key-commitment" + salt),
    }


def position(counter: int, final: bool) -> bytes:
    assert 0 <= counter < 2**40
    return struct.pack(">Q", counter) + (b"\x01" if final else b"\x00")


def seal(keys: tuple, header: bytes, counter: int, final: bool, plaintext: bytes) -> bytes:
    aead_key, synthetic_key = keys
    synthetic = hmac.new(synthetic_key, position(counter, final) + plaintext, hashlib.sha256).digest()[:7]
    return synthetic + AESGCM(aead_key).encrypt(counter.to_bytes(5, "big") + synthetic, plaintext, header + position(counter, final))


def open_record(keys: tuple, header: bytes, counter: int, final: bool, record: bytes) -> bytes:
    aead_key, synthetic_key = keys
    synthetic = record[:7]
    try:
        plaintext = AESGCM(aead_key).decrypt(counter.to_bytes(5, "big") + synthetic, record[7:], header + position(counter, final))
    except InvalidTag:
        raise Rejected("authentication-failed", f"record {counter}")
    expected = hmac.new(synthetic_key, position(counter, final) + plaintext, hashlib.sha256).digest()[:7]
    if not hmac.compare_digest(expected, synthetic):
        raise Rejected("authentication-failed", f"record {counter} nonce is not synthetic")
    return plaintext


# RFC 6962 trees over already-hashed nodes.


def split_of(size: int) -> int:
    split = 1
    while split * 2 < size:
        split *= 2
    return split


def tree(nodes: list, start: int, end: int) -> bytes:
    if end - start == 1:
        return nodes[start]
    split = start + split_of(end - start)
    return sha256(b"\x01" + tree(nodes, start, split) + tree(nodes, split, end))


def siblings(lo: int, hi: int, index: int) -> list:
    if hi - lo == 1:
        return []
    split = lo + split_of(hi - lo)
    if index < split:
        return siblings(lo, split, index) + [("right", split, hi)]
    return siblings(split, hi, index) + [("left", lo, split)]


def fold(node: bytes, path: list, hashes: list) -> bytes:
    for (side, _, _), sibling in zip(path, hashes):
        node = sha256(b"\x01" + node + sibling) if side == "right" else sha256(b"\x01" + sibling + node)
    return node


def page_roots(labels: list) -> list:
    return [tree(labels, start, min(len(labels), start + PAGE)) for start in range(0, len(labels), PAGE)]


def label_page(labels: list, page: int) -> bytes:
    roots = page_roots(labels)
    start, end = page * PAGE, min(len(labels), (page + 1) * PAGE)
    return b"".join(labels[start:end]) + b"".join(tree(roots, lo, hi) for _, lo, hi in siblings(0, len(roots), page))


# Manifest: canonical JSON, validation, name profile.


def is_device_name(segment: str) -> bool:
    stem = re.sub("[A-Z]", lambda match: match.group(0).lower(), segment.split(".")[0].rstrip(" "))
    return stem in {"con", "prn", "aux", "nul"} or re.fullmatch("(com|lpt)[1-9¹²³]", stem) is not None


def name_problem(name: str):
    if any(unicodedata.category(character) in FORBIDDEN_CATEGORIES or character in FORBIDDEN_ASCII for character in name):
        return "forbidden character"
    if unicodedata.normalize("NFC", name) != name:
        return "not NFC"
    if len(name.encode("utf-8")) > 4096:
        return "too long"
    for segment in name.split("/"):
        if segment in ("", ".", ".."):
            return "empty or dot segment"
        if len(segment.encode("utf-8")) > 255:
            return "segment too long"
        if segment.endswith((".", " ")):
            return "trailing dot or space"
        if is_device_name(segment):
            return "device name"
    return None


def name_key(name: str) -> str:
    return unicodedata.normalize("NFC", name.casefold())


def canonical(manifest: dict) -> bytes:
    ordered = {
        "version": manifest["version"],
        "files": [{"name": f["name"], "size": f["size"], "mediaType": f["mediaType"]} for f in manifest["files"]],
        "totalSize": manifest["totalSize"],
    }
    return json.dumps(ordered, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def is_integer(value) -> bool:
    return type(value) is int


def validate(value) -> dict:
    def bad(message):
        raise Rejected("invalid-manifest", message)

    if not isinstance(value, dict) or sorted(value) != ["files", "totalSize", "version"]:
        bad("top-level keys")
    if not is_integer(value["version"]) or value["version"] != 1:
        bad("version")
    files = value["files"]
    if not isinstance(files, list) or not files:
        bad("files must be a non-empty list")
    for entry in files:
        if not isinstance(entry, dict) or sorted(entry) != ["mediaType", "name", "size"]:
            bad("file keys")
        if not isinstance(entry["name"], str) or name_problem(entry["name"]) is not None:
            bad("name")
        if not is_integer(entry["size"]) or entry["size"] < 0:
            bad("size")
        media = entry["mediaType"]
        if not isinstance(media, str) or not (media == "" or (len(media) <= 127 and MEDIA_TYPE.match(media))):
            bad("media type")
    keys = [name_key(entry["name"]) for entry in files]
    if len(set(keys)) != len(keys):
        bad("names collide")
    folders = {"/".join(key.split("/")[: index + 1]) for key in keys for index in range(len(key.split("/")) - 1)}
    if any(key in folders for key in keys):
        bad("a file is also a folder")
    total = sum(entry["size"] for entry in files)
    if not is_integer(value["totalSize"]) or value["totalSize"] != total or total >= SIZE_LIMIT:
        bad("totalSize")
    return value


def decode_manifest_json(data: bytes) -> dict:
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Rejected("invalid-manifest", "not UTF-8 JSON")
    manifest = validate(value)
    if canonical(manifest) != data:
        raise Rejected("invalid-manifest", "not canonical")
    return manifest


def manifest_records_for(json_length: int) -> int:
    needed = -(-(PREFIX + json_length) // MANIFEST_RECORD)
    count = 1
    while count < needed:
        count *= 2
    return count


def manifest_plaintext(manifest: dict, record_count: int, root: bytes) -> bytes:
    data = canonical(manifest)
    count = manifest_records_for(len(data))
    return (struct.pack(">Q", record_count) + root + struct.pack(">I", len(data)) + data).ljust(count * MANIFEST_RECORD, b"\x00")


# The receiver (docs/parcel.md, "Receiver rules").


def open_parcel(link_secret: bytes, parcel: bytes):
    offset = 0

    def take(length: int) -> bytes:
        nonlocal offset
        if offset + length > len(parcel):
            raise Rejected("truncated")
        chunk = parcel[offset : offset + length]
        offset += length
        return chunk

    header = take(HEADER_LENGTH)
    if header[:4] != MAGIC:
        raise Rejected("invalid-header")
    if header[4] != 1:
        raise Rejected("unsupported-version")
    exponent = header[5]
    if not 12 <= exponent <= 22:
        raise Rejected("invalid-record-size")
    sequence = struct.unpack(">I", header[6:10])[0]
    keys = parcel_keys(parcel_secret(link_secret, sequence), header[10:26])
    if not hmac.compare_digest(keys["commitment"], header[26:58]):
        raise Rejected("key-commitment-mismatch")

    first_record = take(MANIFEST_RECORD + OVERHEAD)
    first = open_record(keys["manifest"], header, 0, False, first_record)
    json_length = struct.unpack(">I", first[40:44])[0]
    if json_length > JSON_LIMIT:
        raise Rejected("invalid-manifest", "too large")
    count = manifest_records_for(json_length)
    wire = [first_record] + [take(MANIFEST_RECORD + OVERHEAD) for _ in range(1, count)]
    stream = first + b"".join(open_record(keys["manifest"], header, counter, False, wire[counter]) for counter in range(1, count))
    if any(stream[PREFIX + json_length :]):
        raise Rejected("invalid-manifest", "padding")
    manifest = decode_manifest_json(stream[PREFIX : PREFIX + json_length])
    record_count = struct.unpack(">Q", stream[:8])[0]
    root = stream[8:40]
    size = 2**exponent
    total = manifest["totalSize"]
    records = max(1, -(-total // size))
    if record_count != records:
        raise Rejected("record-count-mismatch")
    digest = sha256(header + b"".join(wire))

    pages = -(-records // PAGE)
    plaintext = bytearray()
    for page in range(pages):
        start, end = page * PAGE, min(records, (page + 1) * PAGE)
        path = siblings(0, pages, page)
        body = take(32 * (end - start + len(path)))
        labels = [body[32 * index : 32 * (index + 1)] for index in range(end - start)]
        hashes = [body[32 * index : 32 * (index + 1)] for index in range(end - start, end - start + len(path))]
        if fold(tree(labels, 0, len(labels)), path, hashes) != root:
            raise Rejected("label-page-mismatch", f"page {page}")
        for index in range(start, end):
            length = size if index < records - 1 else total - (records - 1) * size
            record = take(length + OVERHEAD)
            if sha256(b"\x00" + record) != labels[index - start]:
                raise Rejected("label-mismatch", f"record {index}")
            plaintext += open_record(keys["content"], header, index, index == records - 1, record)
    if offset != len(parcel):
        raise Rejected("trailing-data")
    return manifest, bytes(plaintext), digest


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"FAIL: {message}")


def main() -> None:
    if unicodedata.unidata_version != "15.1.0":
        print(f"warning: this Python has Unicode {unicodedata.unidata_version}; the name profile is defined on 15.1")
    folder = pathlib.Path(__file__).parent
    vectors = json.loads((folder / "vectors.json").read_text())
    link_secret = bytes.fromhex(vectors["linkSecret"])
    salt = bytes.fromhex(vectors["salt"])

    check(base64.urlsafe_b64encode(link_secret).rstrip(b"=").decode() == vectors["linkFragment"], "link fragment")
    room_token = expand(link_secret, b"parcel/v1/room-token")
    check(room_token.hex() == vectors["roomToken"], "room token")
    check(hashlib.sha256(room_token).hexdigest() == vectors["roomTokenHash"], "room token hash")
    for sequence, expected in vectors["parcelSecrets"].items():
        check(parcel_secret(link_secret, int(sequence)).hex() == expected, f"parcel secret {sequence}")
    keys0 = parcel_keys(parcel_secret(link_secret, 0), salt)
    check(keys0["content"][0].hex() == vectors["keys"]["contentKey"], "content key")
    check(keys0["content"][1].hex() == vectors["keys"]["contentSyntheticKey"], "content synthetic key")
    check(keys0["manifest"][0].hex() == vectors["keys"]["manifestKey"], "manifest key")
    check(keys0["manifest"][1].hex() == vectors["keys"]["manifestSyntheticKey"], "manifest synthetic key")
    check(keys0["commitment"].hex() == vectors["keys"]["keyCommitment"], "key commitment")

    for case in vectors["cases"]:
        name = case["name"]
        exponent = case["recordSizeExponent"]
        size = 2**exponent
        sequence = case["sequence"]
        manifest = case["manifest"]
        keys = parcel_keys(parcel_secret(link_secret, sequence), salt)
        check(canonical(manifest).decode("utf-8") == case["manifestJson"], f"{name}: canonical manifest")
        validate(manifest)
        header = MAGIC + bytes([1, exponent]) + struct.pack(">I", sequence) + salt + keys["commitment"]
        check(header.hex() == case["header"], f"{name}: header")

        total = manifest["totalSize"]
        plaintext = bytes(index % 251 for index in range(total))
        records = max(1, -(-total // size))
        check(records == case["recordCount"] == len(case["labels"]), f"{name}: data record count")
        data_records = [seal(keys["content"], header, index, index == records - 1, plaintext[index * size : (index + 1) * size]) for index in range(records)]
        labels = [sha256(b"\x00" + record) for record in data_records]
        check([label.hex() for label in labels] == case["labels"], f"{name}: labels")
        if "dataRecords" in case:
            check([record.hex() for record in data_records] == case["dataRecords"], f"{name}: data records")
        root = tree(page_roots(labels), 0, len(page_roots(labels)))
        check(root.hex() == case["rootHash"], f"{name}: root")

        stream = manifest_plaintext(manifest, records, root)
        count = len(stream) // MANIFEST_RECORD
        manifest_records = [seal(keys["manifest"], header, counter, False, stream[counter * MANIFEST_RECORD : (counter + 1) * MANIFEST_RECORD]) for counter in range(count)]
        check([record.hex() for record in manifest_records] == case["manifestRecords"], f"{name}: manifest records")
        digest = sha256(header + b"".join(manifest_records))
        check(digest.hex() == case["contractDigest"], f"{name}: contract digest")
        pages = [label_page(labels, page) for page in range(-(-records // PAGE))]
        check([page.hex() for page in pages] == case["labelPages"], f"{name}: label pages")

        body = b"".join(pages[page] + b"".join(data_records[page * PAGE : (page + 1) * PAGE]) for page in range(len(pages)))
        opened_manifest, opened, opened_digest = open_parcel(link_secret, header + b"".join(manifest_records) + body)
        check(opened_manifest == manifest and opened == plaintext and opened_digest == digest, f"{name}: opens to its plaintext")
        print(f"ok  {name}: {count} manifest record(s), {len(pages)} label page(s), {records} data record(s)")

    rejections = json.loads((folder / "rejections.json").read_text())
    for case in rejections["manifests"]:
        try:
            decode_manifest_json(bytes.fromhex(case["json"]))
            raise SystemExit(f"FAIL: accepted rejection manifest '{case['name']}'")
        except Rejected as rejection:
            check(rejection.reason == case["reason"], f"manifest '{case['name']}': {rejection.reason} instead of {case['reason']}")
    for case in rejections["parcels"]:
        try:
            open_parcel(bytes.fromhex(case["secret"]), bytes.fromhex(case["parcel"]))
            raise SystemExit(f"FAIL: accepted rejection parcel '{case['name']}'")
        except Rejected as rejection:
            check(rejection.reason == case["reason"], f"parcel '{case['name']}': {rejection.reason} instead of {case['reason']}")
    print(f"all {len(vectors['cases'])} cases match; {len(rejections['manifests'])} manifests and {len(rejections['parcels'])} parcels rejected as expected")


if __name__ == "__main__":
    sys.exit(main())
