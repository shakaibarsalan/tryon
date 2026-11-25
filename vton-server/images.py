"""Data URL helpers. Pure stdlib so the tests run without PyTorch or Pillow."""

from __future__ import annotations

import base64
import binascii
import re
from typing import Optional, Tuple

# Same cap as LIMITS.maxImageBytes in packages/shared.
MAX_IMAGE_BYTES = 1_500_000

_DATA_URL = re.compile(r"^data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]*)$")


class ImageError(ValueError):
    """An input image was refused. `code` matches the API's error codes."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def sniff_mime(data: bytes) -> Optional[str]:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def decode_data_url(field: str, value: object) -> Tuple[str, bytes]:
    """Returns (mime, bytes) for a jpeg/png/webp base64 data URL, or raises ImageError."""
    if not isinstance(value, str) or not value:
        raise ImageError("bad_request", f"{field} is required (a data URL)")
    m = _DATA_URL.match(value)
    if not m:
        raise ImageError("image_invalid", f"{field} must be a base64 data URL of type image/jpeg, image/png or image/webp")
    mime, b64 = m.group(1), re.sub(r"\s+", "", m.group(2))
    if len(b64) * 3 // 4 > MAX_IMAGE_BYTES + 3:
        raise ImageError("image_too_large", f"{field} is larger than {MAX_IMAGE_BYTES} bytes")
    try:
        data = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise ImageError("image_invalid", f"{field} is not valid base64")
    if not data:
        raise ImageError("image_invalid", f"{field} is empty")
    if len(data) > MAX_IMAGE_BYTES:
        raise ImageError("image_too_large", f"{field} is larger than {MAX_IMAGE_BYTES} bytes")
    if sniff_mime(data) != mime:
        raise ImageError("image_invalid", f"{field} content does not match {mime}")
    return mime, data


def to_data_url(mime: str, data: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
