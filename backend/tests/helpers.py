"""Helpers for building test configurations and signed-in API clients."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi.testclient import TestClient

from accounts.passwords import hash_password
from accounts.store import User, get_store
from api.auth import SESSION_COOKIE
from vehicle.library import get_built_in_vehicle, make_config, vehicle_spec_of

TEST_PASSWORD = "correct horse battery"


def sign_in(client: TestClient, email: str | None = None) -> User:
    """Creates an account and gives the client its session cookie (without going through the login route)."""
    store = get_store()
    user = store.create_user(email or f"tester-{uuid.uuid4().hex[:8]}@example.com", "Tester", hash_password(TEST_PASSWORD))
    client.cookies.set(SESSION_COOKIE, store.create_session(user.id))
    return user


def config_for(vehicle_id: str, changes: dict[str, float] | None = None, **options: Any) -> dict[str, Any]:
    vehicle = get_built_in_vehicle(vehicle_id)
    return make_config(vehicle, {**vehicle["geometry"], **(changes or {})}, **options)


def spec_and_powertrain(vehicle_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    vehicle = get_built_in_vehicle(vehicle_id)
    return vehicle_spec_of(vehicle), vehicle["powertrain"]
