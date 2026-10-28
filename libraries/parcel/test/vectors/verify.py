"""
Independent check of the parcel v1 test vectors, written from docs/parcel.md alone (no code shared with the
TypeScript implementation) on pyca/cryptography (OpenSSL) and Python's own Unicode data instead of Web Crypto.

It re-derives every key, reseals every record of every positive vector byte for byte, rebuilds the Merkle root,
then opens each parcel with its own receiver and checks the plaintext. Every rejection vector must be rejected
with the expected reason.

Run: python3 -I libraries/parcel/test/vectors/verify.py   (needs: pip install cryptography; Python 3.13 for Unicode 15.1)
"""

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
HEADER_LENGTH = 54
MANIFEST_RECORD = 4096
OVERHEAD = 7 + 16
TRAILER_LENGTH = 40 + OVERHEAD
SIZE_LIMIT = 2**40
JSON_LIMIT = 2**24 - 4
FORBIDDEN_CATEGORIES = {"Cc", "Cf", "Zl", "Zp", "Cs"}
FORBIDDEN_ASCII = set('\\:*?"<>|')
RESTRICTED = "[a-z0-9][a-z0-9!#$&^_.+-]{0,126}"
MEDIA_TYPE = re.compile(f"^{RESTRICTED}/{RESTRICTED}$")


class Rejected(Exception):
    def __init__(self, reason: str, message: str = ""):
        super().__init__(f"{reason}: {message}")
        self.reason = reason


def expand(secret: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=b"parcel/v1", info=info).derive(secret)


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
    nonce = counter.to_bytes(5, "big") + synthetic
    return synthetic + AESGCM(aead_key).encrypt(nonce, plaintext, header + position(counter, final))


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


def merkle_root(leaves: list) -> bytes:
    if not leaves:
        return hashlib.sha256(b"").digest()
    if len(leaves) == 1:
        return hashlib.sha256(b"\x00" + leaves[0]).digest()
    split = 1
    while split * 2 < len(leaves):
        split *= 2
    return hashlib.sha256(b"\x01" + merkle_root(leaves[:split]) + merkle_root(leaves[split:])).digest()


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
            bad(f"name: {name_problem(entry['name']) if isinstance(entry['name'], str) else 'type'}")
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
    needed = -(-(4 + json_length) // MANIFEST_RECORD)
    count = 1
    while count < needed:
        count *= 2
    return count


def manifest_plaintext(manifest: dict) -> bytes:
    data = canonical(manifest)
    count = manifest_records_for(len(data))
    return (struct.pack(">I", len(data)) + data).ljust(count * MANIFEST_RECORD, b"\x00")


# The receiver (docs/parcel.md, "Receiver rules").


def open_parcel(secret: bytes, parcel: bytes):
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
    keys = parcel_keys(secret, header[6:22])
    if not hmac.compare_digest(keys["commitment"], header[22:54]):
        raise Rejected("key-commitment-mismatch")

    first = open_record(keys["manifest"], header, 0, False, take(MANIFEST_RECORD + OVERHEAD))
    json_length = struct.unpack(">I", first[:4])[0]
    if json_length > JSON_LIMIT:
        raise Rejected("invalid-manifest", "too large")
    count = manifest_records_for(json_length)
    stream = first + b"".join(open_record(keys["manifest"], header, counter, False, take(MANIFEST_RECORD + OVERHEAD)) for counter in range(1, count))
    if any(stream[4 + json_length :]):
        raise Rejected("invalid-manifest", "padding")
    manifest = decode_manifest_json(stream[4 : 4 + json_length])

    size = 2**exponent
    total = manifest["totalSize"]
    records = max(1, -(-total // size))
    plaintext = bytearray()
    leaves = []
    for index in range(records):
        length = size if index < records - 1 else total - (records - 1) * size
        record = take(length + OVERHEAD)
        plaintext += open_record(keys["content"], header, index, index == records - 1, record)
        leaves.append(record)
    trailer = open_record(keys["manifest"], header, count, True, take(TRAILER_LENGTH))
    if offset != len(parcel):
        raise Rejected("trailing-data")
    if struct.unpack(">Q", trailer[:8])[0] != records:
        raise Rejected("record-count-mismatch")
    if not hmac.compare_digest(trailer[8:], merkle_root(leaves)):
        raise Rejected("root-hash-mismatch")
    return manifest, bytes(plaintext)


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"FAIL: {message}")


def main() -> None:
    if unicodedata.unidata_version != "15.1.0":
        print(f"warning: this Python has Unicode {unicodedata.unidata_version}; the name profile is defined on 15.1")
    folder = pathlib.Path(__file__).parent
    vectors = json.loads((folder / "vectors.json").read_text())
    secret = bytes.fromhex(vectors["secret"])
    salt = bytes.fromhex(vectors["salt"])

    import base64

    check(base64.urlsafe_b64encode(secret).rstrip(b"=").decode() == vectors["linkFragment"], "link fragment")
    room_token = expand(secret, b"parcel/v1/room-token")
    check(room_token.hex() == vectors["roomToken"], "room token")
    check(hashlib.sha256(room_token).hexdigest() == vectors["roomTokenHash"], "room token hash")
    keys = parcel_keys(secret, salt)
    check(keys["content"][0].hex() == vectors["keys"]["contentKey"], "content key")
    check(keys["content"][1].hex() == vectors["keys"]["contentSyntheticKey"], "content synthetic key")
    check(keys["manifest"][0].hex() == vectors["keys"]["manifestKey"], "manifest key")
    check(keys["manifest"][1].hex() == vectors["keys"]["manifestSyntheticKey"], "manifest synthetic key")
    check(keys["commitment"].hex() == vectors["keys"]["keyCommitment"], "key commitment")

    for case in vectors["cases"]:
        name = case["name"]
        exponent = case["recordSizeExponent"]
        size = 2**exponent
        manifest = case["manifest"]
        check(canonical(manifest).decode("utf-8") == case["manifestJson"], f"{name}: canonical manifest")
        validate(manifest)
        header = MAGIC + bytes([1, exponent]) + salt + keys["commitment"]
        check(header.hex() == case["header"], f"{name}: header")

        stream = manifest_plaintext(manifest)
        count = len(stream) // MANIFEST_RECORD
        check(count == len(case["manifestRecords"]), f"{name}: manifest record count")
        manifest_records = [seal(keys["manifest"], header, counter, False, stream[counter * MANIFEST_RECORD : (counter + 1) * MANIFEST_RECORD]) for counter in range(count)]
        for counter, record in enumerate(manifest_records):
            check(record.hex() == case["manifestRecords"][counter], f"{name}: manifest record {counter}")

        total = manifest["totalSize"]
        plaintext = bytes(index % 251 for index in range(total))
        records = max(1, -(-total // size))
        check(records == case["recordCount"] == len(case["dataRecords"]), f"{name}: data record count")
        data_records = [seal(keys["content"], header, index, index == records - 1, plaintext[index * size : (index + 1) * size]) for index in range(records)]
        for index, record in enumerate(data_records):
            check(record.hex() == case["dataRecords"][index], f"{name}: data record {index}")

        root = merkle_root(data_records)
        check(root.hex() == case["rootHash"], f"{name}: root hash")
        trailer = seal(keys["manifest"], header, count, True, struct.pack(">Q", records) + root)
        check(trailer.hex() == case["trailer"], f"{name}: trailer")

        opened_manifest, opened = open_parcel(secret, header + b"".join(manifest_records) + b"".join(data_records) + trailer)
        check(opened_manifest == manifest and opened == plaintext, f"{name}: opens to its plaintext")
        print(f"ok  {name}: {count} manifest record(s), {records} data record(s)")

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
