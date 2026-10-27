"""The error shape of the API: {"detail": {"code": ..., "message": ...}}."""

from __future__ import annotations

from fastapi import HTTPException


def fail(status: int, code: str, message: str, headers: dict[str, str] | None = None) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message}, headers=headers)
