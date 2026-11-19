"""Gateway-owned, one-use operator grants for protected delegation routes.

The model-facing route schema stays stable. Grants live only in this process, so
restarting the gateway revokes them. Workers consume through their authenticated
owner RPC rather than trusting a file or a model-supplied approval parameter.
"""

from __future__ import annotations

import threading

_lock = threading.Lock()
_armed: set[tuple[str, str, str]] = set()
_receipts: dict[tuple[str, str, str, str], bool] = {}
_MAX_RECEIPTS = 65536


def _key(profile_id: str, session_id: str, name: str) -> tuple[str, str, str]:
    if not all(isinstance(value, str) and value for value in (profile_id, session_id, name)):
        raise ValueError("route gate requires a profile, session and route")
    from hermes_constants import hermes_home_key
    return hermes_home_key(profile_id), session_id, name


def armed(profile_id: str, session_id: str, name: str) -> bool:
    key = _key(profile_id, session_id, name)
    with _lock:
        return key in _armed


def set_armed(profile_id: str, session_id: str, name: str, value: bool) -> bool:
    key = _key(profile_id, session_id, name)
    with _lock:
        if value:
            _armed.add(key)
        else:
            _armed.discard(key)
        return key in _armed


def consume(profile_id: str, session_id: str, name: str, receipt: str = "") -> bool:
    """Atomically spend one grant; a worker outbox replay repeats its receipt."""
    key = _key(profile_id, session_id, name)
    receipt_key = (*key, receipt)
    with _lock:
        if receipt and receipt_key in _receipts:
            return _receipts[receipt_key]
        # Never evict a receipt: an old worker retry could otherwise spend a
        # newly armed grant. Refuse new spends when the bounded cache fills.
        if receipt and len(_receipts) >= _MAX_RECEIPTS:
            return False
        allowed = key in _armed
        _armed.discard(key)
        if receipt:
            _receipts[receipt_key] = allowed
        return allowed
