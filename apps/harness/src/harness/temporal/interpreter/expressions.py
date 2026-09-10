"""The workflow EXPRESSION language — TASK-864 §3.2 — the Python half.

A deterministic, side-effect-free, non-Turing-complete subset of CEL (Common Expression
Language), evaluated by the interpreter for ``core.condition`` (``branches[].when``) and
``core.loop`` (``until``). This module is a line-for-line mirror of
``packages/workflow-contract/src/expressions.ts``; the two are held together by ONE committed
fixture — ``packages/workflow-contract/src/__tests__/fixtures/expressions.fixture.json`` —
that both test suites evaluate (``test_expressions_parity.py`` here). The fixture is the
contract; neither side may grow a capability the other lacks without a case in it.

Pure: no I/O, no clock, no randomness, no imports beyond the standard library. Safe to call from
an activity (``interpreter.core_evaluate``) — and, being pure, replay-safe wherever it runs.

Semantics that matter for parity (asserted by the fixture):

* Errors are VALUES, never raises — an unknown identifier, a missing key, an out-of-range index
  or a type mismatch returns ``EvaluationResult(error=...)``. ``has()`` is the guard.
* Integers stay integers: ``7 / 2`` is ``3`` (truncating toward zero), ``7 % 2`` is ``1``; a
  double operand makes the result a double. A whole-number float is an INT on both sides.
* ``==`` is deep structural equality over JSON values. ``bool`` is never an ``int``.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

EXPRESSION_CONTEXT_ROOTS: tuple[str, ...] = ("trigger", "vars", "nodes")


class ExpressionSyntaxError(Exception):
    """A parse failure. Converted to a result by ``evaluate_expression``."""


class _EvalError(Exception):
    """An evaluation failure. Converted to a result by ``evaluate_expression``."""


@dataclass(frozen=True)
class EvaluationResult:
    value: Any = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None


# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------

_MULTI_CHAR_OPS = ("&&", "||", "==", "!=", "<=", ">=")
_SINGLE_CHAR_OPS = set("()[]{},.:?+-*/%<>!")
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"', "'": "'"}
_IDENT_START = re.compile(r"[A-Za-z_]")
_IDENT_PART = re.compile(r"[A-Za-z0-9_]")


@dataclass(frozen=True)
class _Token:
    kind: str  # num | str | ident | op | eof
    value: Any = None


def _tokenize(source: str) -> list[_Token]:
    tokens: list[_Token] = []
    i = 0
    n = len(source)
    while i < n:
        ch = source[i]
        if ch in " \t\n\r":
            i += 1
            continue
        if ch.isdigit() or (ch == "." and i + 1 < n and source[i + 1].isdigit()):
            j = i
            while j < n and source[j].isdigit():
                j += 1
            is_float = False
            if j < n and source[j] == "." and j + 1 < n and source[j + 1].isdigit():
                is_float = True
                j += 1
                while j < n and source[j].isdigit():
                    j += 1
            if j < n and source[j] in "eE" and j + 1 < n and source[j + 1] in "0123456789+-":
                is_float = True
                j += 1
                if source[j] in "+-":
                    j += 1
                while j < n and source[j].isdigit():
                    j += 1
            text = source[i:j]
            value: Any = float(text) if is_float else int(text)
            # JS `Number("1.0")` is the integer 1; mirror it so `1.0 == 1` on both sides.
            if isinstance(value, float) and value.is_integer() and abs(value) < 2**53:
                value = int(value)
            tokens.append(_Token("num", value))
            i = j
            continue
        if ch in ("'", '"'):
            j = i + 1
            out: list[str] = []
            while j < n and source[j] != ch:
                if source[j] == "\\":
                    if j + 1 >= n:
                        raise ExpressionSyntaxError(f"unterminated escape at {j}")
                    nxt = source[j + 1]
                    out.append(_ESCAPES.get(nxt, nxt))
                    j += 2
                    continue
                out.append(source[j])
                j += 1
            if j >= n or source[j] != ch:
                raise ExpressionSyntaxError(f"unterminated string at {i}")
            tokens.append(_Token("str", "".join(out)))
            i = j + 1
            continue
        if _IDENT_START.match(ch):
            j = i
            while j < n and _IDENT_PART.match(source[j]):
                j += 1
            tokens.append(_Token("ident", source[i:j]))
            i = j
            continue
        two = source[i : i + 2]
        if two in _MULTI_CHAR_OPS:
            tokens.append(_Token("op", two))
            i += 2
            continue
        if ch in _SINGLE_CHAR_OPS:
            tokens.append(_Token("op", ch))
            i += 1
            continue
        raise ExpressionSyntaxError(f"unexpected character {ch!r} at {i}")
    tokens.append(_Token("eof"))
    return tokens


# ---------------------------------------------------------------------------
# Parser — the same precedence ladder as the TypeScript side
# ---------------------------------------------------------------------------

# AST nodes are plain tuples: (kind, ...payload). Kinds mirror the TS union.


class _Parser:
    def __init__(self, tokens: list[_Token]) -> None:
        self._tokens = tokens
        self._pos = 0

    def _peek(self) -> _Token:
        return self._tokens[self._pos]

    def _next(self) -> _Token:
        token = self._tokens[self._pos]
        self._pos += 1
        return token

    def _is_op(self, value: str) -> bool:
        token = self._peek()
        return token.kind == "op" and token.value == value

    def _expect_op(self, value: str) -> None:
        if not self._is_op(value):
            raise ExpressionSyntaxError(f"expected {value!r} at token {self._pos}")
        self._next()

    def parse_expression(self) -> tuple[Any, ...]:
        node = self._parse_ternary()
        if self._peek().kind != "eof":
            raise ExpressionSyntaxError(f"unexpected token at {self._pos}")
        return node

    def _parse_ternary(self) -> tuple[Any, ...]:
        condition = self._parse_or()
        if self._is_op("?"):
            self._next()
            then = self._parse_ternary()
            self._expect_op(":")
            otherwise = self._parse_ternary()
            return ("ternary", condition, then, otherwise)
        return condition

    def _parse_or(self) -> tuple[Any, ...]:
        left = self._parse_and()
        while self._is_op("||"):
            self._next()
            left = ("binary", "||", left, self._parse_and())
        return left

    def _parse_and(self) -> tuple[Any, ...]:
        left = self._parse_comparison()
        while self._is_op("&&"):
            self._next()
            left = ("binary", "&&", left, self._parse_comparison())
        return left

    def _parse_comparison(self) -> tuple[Any, ...]:
        left = self._parse_additive()
        while True:
            token = self._peek()
            is_compare = token.kind == "op" and token.value in ("==", "!=", "<", "<=", ">", ">=")
            is_in = token.kind == "ident" and token.value == "in"
            if not is_compare and not is_in:
                return left
            self._next()
            op = token.value if token.kind == "op" else "in"
            left = ("binary", op, left, self._parse_additive())

    def _parse_additive(self) -> tuple[Any, ...]:
        left = self._parse_multiplicative()
        while self._is_op("+") or self._is_op("-"):
            op = self._next().value
            left = ("binary", op, left, self._parse_multiplicative())
        return left

    def _parse_multiplicative(self) -> tuple[Any, ...]:
        left = self._parse_unary()
        while self._is_op("*") or self._is_op("/") or self._is_op("%"):
            op = self._next().value
            left = ("binary", op, left, self._parse_unary())
        return left

    def _parse_unary(self) -> tuple[Any, ...]:
        if self._is_op("!"):
            self._next()
            return ("unary", "!", self._parse_unary())
        if self._is_op("-"):
            self._next()
            return ("unary", "-", self._parse_unary())
        return self._parse_postfix()

    def _parse_postfix(self) -> tuple[Any, ...]:
        node = self._parse_primary()
        while True:
            if self._is_op("."):
                self._next()
                token = self._next()
                if token.kind != "ident":
                    raise ExpressionSyntaxError(
                        f'expected a field name after "." at token {self._pos}'
                    )
                if self._is_op("("):
                    node = ("method", node, token.value, self._parse_arguments())
                else:
                    node = ("member", node, token.value)
                continue
            if self._is_op("["):
                self._next()
                index = self._parse_ternary()
                self._expect_op("]")
                node = ("index", node, index)
                continue
            return node

    def _parse_arguments(self) -> list[tuple[Any, ...]]:
        self._expect_op("(")
        args: list[tuple[Any, ...]] = []
        if self._is_op(")"):
            self._next()
            return args
        while True:
            args.append(self._parse_ternary())
            if self._is_op(","):
                self._next()
                continue
            self._expect_op(")")
            return args

    def _parse_primary(self) -> tuple[Any, ...]:
        token = self._next()
        if token.kind == "num" or token.kind == "str":
            return ("literal", token.value)
        if token.kind == "ident":
            if token.value == "true":
                return ("literal", True)
            if token.value == "false":
                return ("literal", False)
            if token.value == "null":
                return ("literal", None)
            if self._is_op("("):
                return ("call", token.value, self._parse_arguments())
            return ("ident", token.value)
        if token.kind == "op":
            if token.value == "(":
                inner = self._parse_ternary()
                self._expect_op(")")
                return inner
            if token.value == "[":
                items: list[tuple[Any, ...]] = []
                if self._is_op("]"):
                    self._next()
                    return ("list", items)
                while True:
                    items.append(self._parse_ternary())
                    if self._is_op(","):
                        self._next()
                        continue
                    self._expect_op("]")
                    return ("list", items)
            if token.value == "{":
                entries: list[tuple[tuple[Any, ...], tuple[Any, ...]]] = []
                if self._is_op("}"):
                    self._next()
                    return ("map", entries)
                while True:
                    key = self._parse_ternary()
                    self._expect_op(":")
                    value = self._parse_ternary()
                    entries.append((key, value))
                    if self._is_op(","):
                        self._next()
                        continue
                    self._expect_op("}")
                    return ("map", entries)
            raise ExpressionSyntaxError(f"unexpected {token.value!r} at token {self._pos}")
        raise ExpressionSyntaxError("unexpected end of expression")


def parse_expression(source: str) -> tuple[Any, ...]:
    """Parse ``source``; raises :class:`ExpressionSyntaxError` on a malformed expression."""
    if not isinstance(source, str) or not source.strip():
        raise ExpressionSyntaxError("expression is empty")
    return _Parser(_tokenize(source)).parse_expression()


def expression_problems(source: Any) -> list[str]:
    """The house ``problems: list[str]`` idiom over ONE expression — ``[]`` when it parses."""
    if not isinstance(source, str):
        return ["expression must be a string"]
    try:
        parse_expression(source)
    except ExpressionSyntaxError as exc:
        return [f"expression does not parse: {exc}"]
    except RecursionError:
        return ["expression is too deeply nested"]
    return []


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return (isinstance(value, (int, float))) and not isinstance(value, bool)


def _is_map(value: Any) -> bool:
    return isinstance(value, dict)


def _type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "map"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "int" if value.is_integer() else "double"
    if isinstance(value, str):
        return "string"
    return type(value).__name__


def _deep_equal(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_number(a) and _is_number(b):
        return bool(a == b)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_deep_equal(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, dict) and isinstance(b, dict):
        return set(a) == set(b) and all(_deep_equal(a[k], b[k]) for k in a)
    if type(a) is not type(b):
        return False
    return bool(a == b)


def _normalize_number(value: Any) -> Any:
    """A whole-number float becomes an int, as on the JS side (`Number.isInteger`)."""
    if (
        isinstance(value, float)
        and value.is_integer()
        and math.isfinite(value)
        and abs(value) < 2**53
    ):
        return int(value)
    return value


def _arithmetic(op: str, left: Any, right: Any) -> Any:
    if op == "+":
        if isinstance(left, str) and isinstance(right, str):
            return left + right
        if isinstance(left, list) and isinstance(right, list):
            return [*left, *right]
    if not _is_number(left) or not _is_number(right):
        raise _EvalError(f"no such overload: {_type_name(left)} {op} {_type_name(right)}")
    both_int = _is_int(_normalize_number(left)) and _is_int(_normalize_number(right))
    if op == "+":
        return _normalize_number(left + right)
    if op == "-":
        return _normalize_number(left - right)
    if op == "*":
        return _normalize_number(left * right)
    if op == "/":
        if right == 0:
            raise _EvalError("division by zero")
        if both_int:
            quotient = int(left) / int(right)
            return int(math.trunc(quotient))
        return _normalize_number(left / right)
    if op == "%":
        if not both_int:
            raise _EvalError(f"no such overload: {_type_name(left)} % {_type_name(right)}")
        if right == 0:
            raise _EvalError("modulus by zero")
        # JS `%` keeps the dividend's sign (truncated remainder); Python's keeps the divisor's.
        return int(math.fmod(int(left), int(right)))
    raise _EvalError(f"unknown operator {op}")


def _compare(op: str, left: Any, right: Any) -> bool:
    comparable = (_is_number(left) and _is_number(right)) or (
        isinstance(left, str) and isinstance(right, str)
    )
    if not comparable:
        raise _EvalError(f"no such overload: {_type_name(left)} {op} {_type_name(right)}")
    if op == "<":
        return bool(left < right)
    if op == "<=":
        return bool(left <= right)
    if op == ">":
        return bool(left > right)
    if op == ">=":
        return bool(left >= right)
    raise _EvalError(f"unknown comparison {op}")


def _require_bool(value: Any, where: str) -> bool:
    if not isinstance(value, bool):
        raise _EvalError(f"{where} expects a boolean, got {_type_name(value)}")
    return value


def _evaluate_has(node: tuple[Any, ...], context: dict[str, Any]) -> bool:
    if node[0] != "member":
        raise _EvalError("has() takes a field selection, e.g. has(vars.patientAge)")
    try:
        base = _eval(node[1], context)
    except _EvalError:
        return False
    return _is_map(base) and node[2] in base


def _eval(node: tuple[Any, ...], context: dict[str, Any]) -> Any:
    kind = node[0]
    if kind == "literal":
        return node[1]
    if kind == "ident":
        name = node[1]
        if name not in context:
            raise _EvalError(f"undeclared reference to '{name}'")
        return context[name]
    if kind == "list":
        return [_eval(item, context) for item in node[1]]
    if kind == "map":
        out: dict[str, Any] = {}
        for key_node, value_node in node[1]:
            key = _eval(key_node, context)
            if not isinstance(key, str):
                raise _EvalError(f"map keys must be strings, got {_type_name(key)}")
            out[key] = _eval(value_node, context)
        return out
    if kind == "member":
        base = _eval(node[1], context)
        field = node[2]
        if not _is_map(base):
            raise _EvalError(f"no such key: '{field}' on {_type_name(base)}")
        if field not in base:
            raise _EvalError(f"no such key: '{field}'")
        return base[field]
    if kind == "index":
        base = _eval(node[1], context)
        index = _eval(node[2], context)
        if isinstance(base, list):
            if not _is_int(_normalize_number(index)):
                raise _EvalError(f"list index must be an int, got {_type_name(index)}")
            index = int(index)
            if index < 0 or index >= len(base):
                raise _EvalError(f"index {index} out of range")
            return base[index]
        if _is_map(base):
            if not isinstance(index, str):
                raise _EvalError(f"map key must be a string, got {_type_name(index)}")
            if index not in base:
                raise _EvalError(f"no such key: '{index}'")
            return base[index]
        raise _EvalError(f"cannot index a {_type_name(base)}")
    if kind == "unary":
        if node[1] == "!":
            return not _require_bool(_eval(node[2], context), "!")
        operand = _eval(node[2], context)
        if not _is_number(operand):
            raise _EvalError(f"no such overload: -{_type_name(operand)}")
        return _normalize_number(-operand)
    if kind == "binary":
        op = node[1]
        if op == "&&":
            left = _require_bool(_eval(node[2], context), "&&")
            if not left:
                return False
            return _require_bool(_eval(node[3], context), "&&")
        if op == "||":
            left = _require_bool(_eval(node[2], context), "||")
            if left:
                return True
            return _require_bool(_eval(node[3], context), "||")
        left = _eval(node[2], context)
        right = _eval(node[3], context)
        if op == "==":
            return _deep_equal(left, right)
        if op == "!=":
            return not _deep_equal(left, right)
        if op in ("<", "<=", ">", ">="):
            return _compare(op, left, right)
        if op == "in":
            if isinstance(right, list):
                return any(_deep_equal(item, left) for item in right)
            if _is_map(right):
                if not isinstance(left, str):
                    raise _EvalError(f"map membership needs a string key, got {_type_name(left)}")
                return left in right
            raise _EvalError(f"no such overload: {_type_name(left)} in {_type_name(right)}")
        return _arithmetic(op, left, right)
    if kind == "ternary":
        condition = _require_bool(_eval(node[1], context), "?:")
        return _eval(node[2], context) if condition else _eval(node[3], context)
    if kind == "call":
        name, args = node[1], node[2]
        if name == "has":
            if len(args) != 1:
                raise _EvalError("has() takes exactly one argument")
            return _evaluate_has(args[0], context)
        return _call_function(name, [_eval(arg, context) for arg in args])
    if kind == "method":
        target = _eval(node[1], context)
        args = [_eval(arg, context) for arg in node[3]]
        return _call_method(node[2], target, args)
    raise _EvalError(f"unknown node kind {kind}")


def _call_function(name: str, args: list[Any]) -> Any:
    def one() -> Any:
        if len(args) != 1:
            raise _EvalError(f"{name}() takes exactly one argument")
        return args[0]

    if name == "size":
        value = one()
        if isinstance(value, str):
            return len(value)
        if isinstance(value, (list, dict)):
            return len(value)
        raise _EvalError(f"size() is not defined on {_type_name(value)}")
    if name == "string":
        value = one()
        if isinstance(value, str):
            return value
        if isinstance(value, bool):
            return "true" if value else "false"
        if _is_number(value):
            value = _normalize_number(value)
            return str(value)
        raise _EvalError(f"string() is not defined on {_type_name(value)}")
    if name == "int":
        value = one()
        if isinstance(value, bool):
            return 1 if value else 0
        if _is_number(value):
            return int(math.trunc(value))
        if isinstance(value, str):
            if not re.fullmatch(r"[+-]?\d+", value.strip()):
                raise _EvalError(f"int() cannot parse {value!r}")
            return int(value.strip())
        raise _EvalError(f"int() is not defined on {_type_name(value)}")
    if name == "double":
        value = one()
        if _is_number(value):
            return value
        if isinstance(value, str):
            try:
                if not value.strip():
                    raise ValueError
                return _normalize_number(float(value.strip()))
            except ValueError as exc:
                raise _EvalError(f"double() cannot parse {value!r}") from exc
        raise _EvalError(f"double() is not defined on {_type_name(value)}")
    raise _EvalError(f"unknown function {name}()")


def _call_method(name: str, target: Any, args: list[Any]) -> Any:
    if name in ("contains", "startsWith", "endsWith"):
        if not isinstance(target, str):
            raise _EvalError(f"{name}() is not defined on {_type_name(target)}")
        if len(args) != 1 or not isinstance(args[0], str):
            raise _EvalError(f"{name}() takes exactly one string argument")
        needle = args[0]
        if name == "contains":
            return needle in target
        if name == "startsWith":
            return target.startswith(needle)
        return target.endswith(needle)
    if name == "size":
        return _call_function("size", [target])
    raise _EvalError(f"unknown method {name}()")


def evaluate_expression(source: str, context: dict[str, Any]) -> EvaluationResult:
    """Evaluate ``source`` against the run context ``{trigger, vars, nodes}``. TOTAL."""
    try:
        ast = parse_expression(source)
    except ExpressionSyntaxError as exc:
        return EvaluationResult(error=str(exc))
    except RecursionError:
        # TASK-947 R1 #2 — the parser recurses too; ~120 nested parentheses (244 characters,
        # under the authoring length cap) escaped as a raw RecursionError through
        # `compose_prompt` and the `core.agent` activity. TOTAL means the parse as well.
        return EvaluationResult(error="expression too deeply nested")
    try:
        return EvaluationResult(value=_eval(ast, context))
    except _EvalError as exc:
        return EvaluationResult(error=str(exc))
    except RecursionError:
        return EvaluationResult(error="expression too deeply nested")


def evaluate_condition(source: str, context: dict[str, Any]) -> tuple[bool, str | None]:
    """``(taken, error)`` — taken ONLY on the boolean ``True``; an error never routes a branch."""
    result = evaluate_expression(source, context)
    if result.error is not None:
        return False, result.error
    if not isinstance(result.value, bool):
        return False, f"condition must evaluate to a boolean, got {_type_name(result.value)}"
    return result.value, None
