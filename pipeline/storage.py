"""Object storage: Cloudflare R2 (S3 API) in the cloud, a local folder for dev.

Key layout (same for both backends; the Workers use the same keys):
    layouts/<id>.json        layouts edited in the studio
    state/selected.json      {"layout": "<id>"} — what the frame shows
    data/data.json           latest forecast data (drives studio live preview)
    renders/<id>.png         1-bit 800x480 (served to the frame)
    renders/<id>.bmp         1-bit BMP of the same (fallback if PNG decode fails on device)
    renders/<id>-grey.png    4-grey version
    renders/<id>-thumb.png   400x240 preview for the gallery
    renders/index.json       render timestamps
"""
from __future__ import annotations

import os
from pathlib import Path


class LocalStorage:
    def __init__(self, root: str | Path):
        # Always work with the full path, so relative folders like "out" work too.
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _p(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root.resolve() not in p.parents:
            raise ValueError("bad key")
        return p

    def get(self, key: str) -> bytes | None:
        p = self._p(key)
        return p.read_bytes() if p.exists() else None

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        p = self._p(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(p)

    def list(self, prefix: str) -> list[str]:
        base = self._p(prefix) if prefix else self.root
        if not base.exists():
            return []
        # as_posix(): keys always use "/" (like R2), including on Windows
        return sorted(p.relative_to(self.root).as_posix() for p in base.rglob("*") if p.is_file()
                      and not p.name.endswith(".tmp"))


class R2Storage:
    """Needs an R2 API token scoped to *this bucket only* with Object Read & Write.
    Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET."""

    def __init__(self):
        import boto3
        from botocore.config import Config

        self.bucket = os.environ["R2_BUCKET"]
        self.s3 = boto3.client(
            "s3",
            endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
        )

    def get(self, key: str) -> bytes | None:
        try:
            return self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self.s3.exceptions.NoSuchKey:
            return None

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type,
                           CacheControl="no-store")

    def list(self, prefix: str) -> list[str]:
        keys, token = [], None
        while True:
            kw = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                kw["ContinuationToken"] = token
            r = self.s3.list_objects_v2(**kw)
            keys += [o["Key"] for o in r.get("Contents", [])]
            if not r.get("IsTruncated"):
                return keys
            token = r["NextContinuationToken"]


def make_storage(kind: str, local_dir: str = "out"):
    return R2Storage() if kind == "r2" else LocalStorage(local_dir)
