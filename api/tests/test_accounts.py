"""Round-trip CRUD test against the accounts service.

Uses a fake in-memory stand-in for the Supabase client so the suite runs
without network. A real end-to-end test against Supabase lives out of band
(see the README verification steps).
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from app.models.account import AccountCreate, AccountUpdate
from app.services import accounts_service


class FakeQuery:
    def __init__(self, table: "FakeTable", op: str, payload: Any = None):
        self.table = table
        self.op = op
        self.payload = payload
        self.filters: list[tuple[str, str, Any]] = []
        self._single = False

    def eq(self, col: str, val: Any) -> "FakeQuery":
        self.filters.append(("eq", col, val))
        return self

    def gte(self, col: str, val: Any) -> "FakeQuery":
        self.filters.append(("gte", col, val))
        return self

    def order(self, *_a, **_k) -> "FakeQuery":
        return self

    def maybe_single(self) -> "FakeQuery":
        self._single = True
        return self

    def _matches(self, row: dict) -> bool:
        for kind, col, val in self.filters:
            if kind == "eq" and row.get(col) != val:
                return False
            if kind == "gte" and str(row.get(col)) < str(val):
                return False
        return True

    def execute(self):
        rows = self.table.rows
        if self.op == "insert":
            self.table.rows.append(dict(self.payload))
            return type("R", (), {"data": [self.payload]})
        if self.op == "select":
            matched = [r for r in rows if self._matches(r)]
            data: Any = matched[0] if self._single else matched
            if self._single and not matched:
                data = None
            return type("R", (), {"data": data})
        if self.op == "update":
            updated: list[dict] = []
            for r in rows:
                if self._matches(r):
                    r.update(self.payload)
                    updated.append(r)
            return type("R", (), {"data": updated})
        raise AssertionError(f"unsupported op {self.op}")


class FakeTable:
    def __init__(self):
        self.rows: list[dict] = []

    def insert(self, payload): return FakeQuery(self, "insert", payload)
    def select(self, *_): return FakeQuery(self, "select")
    def update(self, payload): return FakeQuery(self, "update", payload)


class FakeSupabase:
    def __init__(self):
        self.tables: dict[str, FakeTable] = {}

    def table(self, name: str) -> FakeTable:
        return self.tables.setdefault(name, FakeTable())


@pytest.fixture
def sb():
    return FakeSupabase()


USER_ID = "11111111-1111-1111-1111-111111111111"


def test_create_get_update_account(sb):
    created = accounts_service.create_account(
        sb,
        USER_ID,
        AccountCreate(
            first_name="Nirav",
            last_name="Polara",
            chequing_balance=Decimal("1200"),
            savings_balance=Decimal("8500"),
            credit_score=672,
        ),
    )
    assert created["user_id"] == USER_ID
    assert created["first_name"] == "Nirav"

    fetched = accounts_service.get_account(sb, USER_ID)
    assert fetched["last_name"] == "Polara"

    updated = accounts_service.update_account(
        sb, USER_ID, AccountUpdate(credit_score=710)
    )
    assert updated["credit_score"] == 710


def test_get_missing_account_raises(sb):
    with pytest.raises(Exception):
        accounts_service.get_account(sb, "does-not-exist")
