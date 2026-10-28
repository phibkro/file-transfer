"""
Independent check of the parcel v1 test vectors, written from docs/parcel.md alone (no code shared with the
TypeScript implementation) on pyca/cryptography (OpenSSL) instead of Web Crypto. It re-derives every key,
re-encrypts every record, rebuilds the Merkle root, and compares each byte with vectors.json; then it decrypts
each case and checks the plaintext.

Run: python3 -I libraries/parcel/test/vectors/verify.py   (needs: pip install cryptography)
"""

import base64
import hashlib
import json
import pathlib
import struct
import sys

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAGIC = bytes([0x45, 0x32, 0x45, 0x01])
INFO = {
    "room_token": b"e2e-transfer/v1/room-token",
    "content": b"e2e-transfer/v1/content",
    "manifest": b"e2e-transfer/v1/manifest",
    "commitment": b"e2e-transfer/v1/commitment",
}


def hkdf(secret: bytes, salt: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(secret)


def nonce(counter: int, final: bool) -> bytes:
    return counter.to_bytes(11, "big") + (b"\x01" if final else b"\x00")


def merkle_root(leaves: list[bytes]) -> bytes:
    if not leaves:
        return hashlib.sha256(b"").digest()
    if len(leaves) == 1:
        return hashlib.sha256(b"\x00" + leaves[0]).digest()
    split = 1
    while split * 2 < len(leaves):
        split *= 2
    return hashlib.sha256(b"\x01" + merkle_root(leaves[:split]) + merkle_root(leaves[split:])).digest()


def manifest_plaintext(manifest: dict, record_size: int) -> bytes:
    ordered = {
        "version": manifest["version"],
        "files": [{"name": f["name"], "size": f["size"], "mediaType": f["mediaType"]} for f in manifest["files"]],
        "totalSize": manifest["totalSize"],
    }
    encoded = json.dumps(ordered, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    assert 4 + len(encoded) <= record_size
    return struct.pack(">I", len(encoded)) + encoded + bytes(record_size - 4 - len(encoded))


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"FAIL: {message}")


def main() -> None:
    vectors = json.loads((pathlib.Path(__file__).parent / "vectors.json").read_text())
    secret = bytes.fromhex(vectors["secret"])
    salt = bytes.fromhex(vectors["salt"])

    check(base64.urlsafe_b64encode(secret).rstrip(b"=").decode() == vectors["linkFragment"], "link fragment")
    room_token = hkdf(secret, b"", INFO["room_token"])
    check(room_token.hex() == vectors["roomToken"], "room token")
    check(hashlib.sha256(room_token).hexdigest() == vectors["roomTokenHash"], "room token hash")

    content_key = hkdf(secret, salt, INFO["content"])
    manifest_key = hkdf(secret, salt, INFO["manifest"])
    commitment = hkdf(secret, salt, INFO["commitment"])
    check(content_key.hex() == vectors["keys"]["contentKey"], "content key")
    check(manifest_key.hex() == vectors["keys"]["manifestKey"], "manifest key")
    check(commitment.hex() == vectors["keys"]["keyCommitment"], "key commitment")

    for case in vectors["cases"]:
        name = case["name"]
        exponent = case["recordSizeExponent"]
        record_size = 2**exponent
        total = case["manifest"]["totalSize"]
        plaintext = bytes(index % 251 for index in range(total))

        header = MAGIC + bytes([1, exponent]) + salt + commitment
        check(len(header) == 54 and header.hex() == case["header"], f"{name}: header")

        manifest_record = AESGCM(manifest_key).encrypt(nonce(0, False), manifest_plaintext(case["manifest"], record_size), header)
        check(manifest_record.hex() == case["manifestRecord"], f"{name}: manifest record")

        count = max(1, -(-total // record_size))
        check(count == case["recordCount"] == len(case["dataRecords"]), f"{name}: record count")
        records = []
        for index in range(count):
            chunk = plaintext[index * record_size : (index + 1) * record_size]
            record = AESGCM(content_key).encrypt(nonce(index, index == count - 1), chunk, header)
            check(record.hex() == case["dataRecords"][index], f"{name}: data record {index}")
            check(AESGCM(content_key).decrypt(nonce(index, index == count - 1), record, header) == chunk, f"{name}: decrypt {index}")
            records.append(record)

        root = merkle_root(records)
        check(root.hex() == case["rootHash"], f"{name}: root hash")
        trailer = AESGCM(manifest_key).encrypt(nonce(1, True), struct.pack(">Q", count) + root, header)
        check(trailer.hex() == case["trailer"], f"{name}: trailer")
        print(f"ok  {name}: {count} data record(s), {len(header) + len(manifest_record) + sum(map(len, records)) + len(trailer)} bytes")

    print(f"all {len(vectors['cases'])} cases match")


if __name__ == "__main__":
    sys.exit(main())
