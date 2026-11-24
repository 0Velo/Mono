#!/usr/bin/env python3
"""Independent reference implementation used to generate derivation fixtures.

This deliberately shares no code with the wallet: BIP39 seed stretching,
SLIP-0010 hardened ed25519 derivation and the ed25519 public key are written
from the specifications using only hashlib and `cryptography`. The TypeScript
suite then checks the wallet's own implementation against these vectors, so a
bug in the wallet's HMAC/derivation cannot hide behind itself.

Run:  python3 scripts/security/oracle/slip10_oracle.py > scripts/security/fixtures/derivation-vectors.json
"""
import hashlib
import hmac
import json
import unicodedata

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

HARDENED = 0x80000000
BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(data: bytes) -> str:
    value = int.from_bytes(data, "big")
    out = ""
    while value > 0:
        value, rem = divmod(value, 58)
        out = BASE58_ALPHABET[rem] + out
    pad = 0
    for byte in data:
        if byte == 0:
            pad += 1
        else:
            break
    return "1" * pad + (out or ("" if data else ""))


def bip39_seed(mnemonic: str, passphrase: str = "") -> bytes:
    """BIP39: PBKDF2-HMAC-SHA512 over the NFKD-normalised phrase, 2048 rounds."""
    normalized = unicodedata.normalize("NFKD", " ".join(mnemonic.split()))
    salt = unicodedata.normalize("NFKD", "mnemonic" + passphrase)
    return hashlib.pbkdf2_hmac("sha512", normalized.encode(), salt.encode(), 2048, 64)


def slip10_ed25519(seed: bytes, path: str) -> bytes:
    """SLIP-0010 ed25519: every segment must be hardened."""
    segments = [seg for seg in path.strip().replace("m/", "", 1).split("/") if seg]
    i = hmac.new(b"ed25519 seed", seed, hashlib.sha512).digest()
    key, chain = i[:32], i[32:]
    for seg in segments:
        if not seg.endswith("'"):
            raise ValueError(f"ed25519 supports hardened derivation only: {seg}")
        index = int(seg[:-1]) + HARDENED
        data = b"\x00" + key + index.to_bytes(4, "big")
        i = hmac.new(chain, data, hashlib.sha512).digest()
        key, chain = i[:32], i[32:]
    return key


def address_for(mnemonic: str, path: str) -> str:
    private_seed = slip10_ed25519(bip39_seed(mnemonic), path)
    public = Ed25519PrivateKey.from_private_bytes(private_seed).public_key()
    return b58encode(public.public_bytes(Encoding.Raw, PublicFormat.Raw))


MNEMONICS = {
    "bip39-test-12": "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "bip39-test-24": "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
    "mixed-12": "legal winner thank year wave sausage worth useful legal winner thank yellow",
}

PATHS = ["m/44'/501'/0'/0'", "m/44'/501'/1'/0'", "m/44'/501'/2'/0'"]


def main() -> None:
    vectors = []
    for name, mnemonic in MNEMONICS.items():
        for path in PATHS:
            vectors.append(
                {"name": name, "mnemonic": mnemonic, "path": path, "address": address_for(mnemonic, path)}
            )
    print(json.dumps({"generator": "slip10_oracle.py (BIP39 + SLIP-0010 reference)", "vectors": vectors}, indent=2))


if __name__ == "__main__":
    main()
