#!/usr/bin/env python3
"""
DOM XSS Review v4.0

A source-aware static review plus a browser-driven exploitation suite for
DOM-based XSS. It is deliberately conservative: a confirmed execution is
evidence, but a negative result only covers the inputs and payloads tested.

Static mode:
  - same-origin HTML/JS crawl, including modulepreload/import()/worker chunks
  - HTML attribute sinks (on*, srcdoc, javascript: URLs, meta refresh)
  - JavaScript source/sink rules with a lightweight taint pass
  - optional local source-tree scan (.js/.jsx/.ts/.tsx/.vue/.svelte/.astro)
  - CSP parsing and reporting
  - source-map expansion when a .map is available

Dynamic mode (Playwright):
  - query strings, hash fragments, path segments
  - form fields (GET by default; POST with --allow-post)
  - postMessage (string and common object shapes)
  - localStorage/sessionStorage keys, window.name, document.referrer, cookies
  - context-specific payloads: HTML, attribute breakout, JS string, template,
    javascript: URL, srcdoc, mXSS
  - execution marker, dialog capture, CSP-violation capture, frame traversal

Only test systems you are authorized to assess.

Python 3.9+.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import time
from collections import Counter, deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import (
    parse_qsl,
    quote,
    unquote,
    urlencode,
    urljoin,
    urlparse,
    urlunparse,
)
from urllib.request import Request, urlopen

VERSION = "4.0"
USER_AGENT = "DOMXSSReview/4.0"
DEFAULT_PORTS = {"http": 80, "https": 443}
JS_EXTENSIONS = (".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx")
PAGE_EXTENSIONS = (".html", ".htm", ".xhtml")
SOURCE_EXTENSIONS = (
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
    ".vue", ".svelte", ".astro", ".html", ".htm",
)
SKIP_EXTENSIONS = (
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif",
    ".ico", ".css", ".pdf", ".zip", ".gz", ".tar", ".woff",
    ".woff2", ".ttf", ".otf", ".mp4", ".webm", ".mp3", ".wav",
    ".map", ".wasm",
)
SENSITIVE_KEYS = (
    "token", "auth", "jwt", "key", "secret", "password", "passwd",
    "session", "csrf", "xsrf", "api_key", "apikey", "access_token",
    "refresh_token", "id_token",
)
SAFE_RECEIVERS = (
    "formdata", "searchparams", "urlsearchparams", "headers", "params",
    "classlist", "dataset", "map", "set", "array", "list", "buffer",
    "chunks", "parts", "queryselector", "getelementbyid",
)
COMMON_QUERY_NAMES = (
    "q", "query", "search", "s", "id", "page", "url", "redirect",
    "next", "return", "returnurl", "dest", "destination", "target",
    "callback", "cb", "lang", "language", "name", "message", "msg",
    "html", "content", "template", "view", "file", "path", "debug",
    "u", "link", "src", "href",
)
COMMON_HASH_NAMES = ("h", "q", "query", "search", "url", "redirect", "next", "path")
MARK = "__domxss_mark"

BASE_LINE = 1


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def origin(url: str):
    """Return (scheme, host, effective_port), or None for a malformed URL."""
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:
        return None
    scheme = (parsed.scheme or "").lower()
    if port is None:
        port = DEFAULT_PORTS.get(scheme)
    return (scheme, (parsed.hostname or "").lower(), port)


def normalize(url: str, keep_query: bool = True, keep_hash: bool = False) -> str:
    parsed = urlparse(url)
    return urlunparse((
        parsed.scheme,
        parsed.netloc,
        parsed.path or "/",
        parsed.params,
        parsed.query if keep_query else "",
        parsed.fragment if keep_hash else "",
    ))


def same_origin(a: str, b: str) -> bool:
    oa, ob = origin(a), origin(b)
    return oa is not None and oa == ob


def allowed_url(candidate: str, base: str, allowed_origin, allow_path=()):
    try:
        absolute = urljoin(base, candidate)
        parsed = urlparse(absolute)
        if parsed.scheme.lower() not in ("http", "https"):
            return None
        if origin(absolute) != allowed_origin:
            return None
        if parsed.username or parsed.password:
            return None
        path = parsed.path.lower()
        if path.endswith(SKIP_EXTENSIONS):
            return None
        if allow_path and not any(re.search(rx, parsed.path) for rx in allow_path):
            return None
        return absolute
    except (ValueError, TypeError):
        return None


def is_html_type(content_type: str) -> bool:
    value = (content_type or "").split(";", 1)[0].strip().lower()
    return value in ("text/html", "application/xhtml+xml")


def is_javascript_type(content_type: str) -> bool:
    value = (content_type or "").split(";", 1)[0].strip().lower()
    return (
        "javascript" in value
        or "ecmascript" in value
        or value in ("text/jsx", "text/typescript", "application/typescript")
    )


def redact_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        pairs = parse_qsl(parsed.query, keep_blank_values=True)
        redacted = []
        for key, value in pairs:
            if any(s in key.lower() for s in SENSITIVE_KEYS):
                redacted.append((key, "[redacted]"))
            else:
                redacted.append((key, value))
        return urlunparse((
            parsed.scheme, parsed.netloc, parsed.path, parsed.params,
            urlencode(redacted), parsed.fragment,
        ))
    except (ValueError, TypeError):
        return url


def redact_headers(headers) -> dict:
    out = {}
    for key, value in (headers or {}).items():
        if key.lower() in ("authorization", "cookie", "set-cookie", "x-api-key"):
            out[key] = "[redacted]"
        else:
            out[key] = value
    return out


def line_number(text: str, pos: int) -> int:
    return text.count("\n", 0, max(0, pos)) + 1


def snippet_at(text: str, pos: int, before: int = 180, after: int = 320) -> str:
    start = max(0, pos - before)
    end = min(len(text), pos + after)
    snippet = text[start:end].strip()
    if len(snippet) > 700:
        snippet = snippet[:697] + "..."
    return snippet


def split_csv(value: str):
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def parse_headers(values):
    headers = {}
    for raw in values or []:
        if ":" not in raw:
            raise ValueError(f"Header must look like 'Name: value': {raw!r}")
        name, value = raw.split(":", 1)
        name, value = name.strip(), value.strip()
        if not name or "\r" in value or "\n" in value:
            raise ValueError(f"Invalid header: {raw!r}")
        headers[name] = value
    return headers


def parse_cookie(value: str):
    if not value:
        return {}
    if "=" not in value:
        raise ValueError("Cookie must look like 'name=value'")
    name, val = value.split("=", 1)
    return {name.strip(): val.strip()}


def safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def read_text(path: Path, limit: int) -> str:
    data = path.read_bytes()[:limit]
    return data.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# JavaScript masking, extraction, and taint
# ---------------------------------------------------------------------------


def mask_js(text: str) -> str:
    """Blank comments and string/template contents, preserving newlines.

    The mask is used only for matching code. Snippets and expressions are still
    read from the original text, so payload strings remain visible in reports.
    """
    out = list(text)
    i = 0
    state = "code"
    quote_char = ""
    n = len(text)
    while i < n:
        char = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if state == "code":
            if char == "/" and nxt == "/":
                out[i] = out[i + 1] = " "
                state = "line"
                i += 2
                continue
            if char == "/" and nxt == "*":
                out[i] = out[i + 1] = " "
                state = "block"
                i += 2
                continue
            if char in ("'", '"', "`"):
                quote_char = char
                out[i] = " "
                state = "string"
                i += 1
                continue
            i += 1
            continue
        if state == "line":
            if char == "\n":
                state = "code"
            else:
                out[i] = " "
            i += 1
            continue
        if state == "block":
            if char == "*" and nxt == "/":
                out[i] = out[i + 1] = " "
                state = "code"
                i += 2
                continue
            if char != "\n":
                out[i] = " "
            i += 1
            continue
        if state == "string":
            if char == "\\":
                out[i] = " "
                if i + 1 < n and text[i + 1] != "\n":
                    out[i + 1] = " "
                i += 2
                continue
            if char == quote_char:
                out[i] = " "
                state = "code"
                i += 1
                continue
            if char != "\n":
                out[i] = " "
            i += 1
            continue
    return "".join(out)


def _scan_expression(text: str, start: int) -> str:
    depth = 0
    quote_char = ""
    i = start
    n = len(text)
    while i < n:
        char = text[i]
        if quote_char:
            if char == "\\":
                i += 2
                continue
            if char == quote_char:
                quote_char = ""
            i += 1
            continue
        if char in ("'", '"', "`"):
            quote_char = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            if depth == 0:
                break
            depth -= 1
        elif char in ";\n" and depth == 0:
            break
        i += 1
    return text[start:i].strip()


def extract_rhs(text: str, match: re.Match) -> str:
    eq = text.find("=", match.start(), min(len(text), match.end() + 40))
    if eq < 0:
        return ""
    return _scan_expression(text, eq + 1)


def matching_paren(text: str, open_pos: int):
    depth = 0
    quote_char = ""
    i = open_pos
    n = len(text)
    while i < n:
        char = text[i]
        if quote_char:
            if char == "\\":
                i += 2
                continue
            if char == quote_char:
                quote_char = ""
            i += 1
            continue
        if char in ("'", '"', "`"):
            quote_char = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def extract_args(text: str, match: re.Match):
    open_pos = text.rfind("(", match.start(), min(len(text), match.end()))
    if open_pos < 0:
        return []
    close_pos = matching_paren(text, open_pos)
    if close_pos < 0:
        return []
    body = text[open_pos + 1:close_pos]
    args, current, depth, quote_char = [], [], 0, ""
    i = 0
    while i < len(body):
        char = body[i]
        if quote_char:
            current.append(char)
            if char == "\\" and i + 1 < len(body):
                current.append(body[i + 1])
                i += 2
                continue
            if char == quote_char:
                quote_char = ""
        elif char in ("'", '"', "`"):
            quote_char = char
            current.append(char)
        elif char in "([{":
            depth += 1
            current.append(char)
        elif char in ")]}":
            depth -= 1
            current.append(char)
        elif char == "," and depth == 0:
            args.append("".join(current).strip())
            current = []
        else:
            current.append(char)
        i += 1
    if current:
        args.append("".join(current).strip())
    return args


def extract_braced(text: str, match: re.Match) -> str:
    open_pos = text.find("{", match.start(), min(len(text), match.end() + 120))
    if open_pos < 0:
        return ""
    depth = 0
    quote_char = ""
    i = open_pos
    n = len(text)
    while i < n:
        char = text[i]
        if quote_char:
            if char == "\\":
                i += 2
                continue
            if char == quote_char:
                quote_char = ""
        elif char in ("'", '"', "`"):
            quote_char = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[open_pos + 1:i].strip()
        i += 1
    return ""


def extract_attr_value(text: str, match: re.Match) -> str:
    tail = text[match.end():match.end() + 300]
    found = re.search(r"""=\s*(['"])(.*?)\1""", tail, re.S)
    return found.group(2).strip() if found else ""


LITERAL_RE = re.compile(
    r"""^\s*(?:'[^']*'|"[^"]*"|`[^`$]*`|-?\d+(?:\.\d+)?|true|false|null|undefined)\s*$""",
    re.S,
)
SANITIZER_RE = re.compile(
    r"(?:DOMPurify\s*\.\s*sanitize|sanitizeHtml|sanitizeHTML|escapeHtml|"
    r"escapeHTML|encodeURIComponent|encodeURI|textContent|createTextNode|"
    r"validator\s*\.\s*escape|he\s*\.\s*escape|_\s*\.\s*escape|"
    r"htmlEscape|escapeForHtml)",
    re.I,
)
IDENT_RE = re.compile(r"[A-Za-z_$][\w$]*")
PROPERTY_NAMES = {
    "innerhtml", "outerhtml", "src", "href", "action", "formaction",
    "srcdoc", "data", "textcontent", "value", "name", "type", "id",
    "class", "style", "location", "hash", "search", "pathname",
}
ASSIGN_DECL_RE = re.compile(
    r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)"
)
ASSIGN_PLAIN_RE = re.compile(
    r"(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*([^=;\n][^;\n]*)"
)


def source_label(expr: str, tainted: dict):
    match = SOURCE_RE.search(expr)
    if match:
        return match.group(0)[:120]
    for name, label in tainted.items():
        if re.search(r"(?<![\w$.])" + re.escape(name) + r"(?![\w$])", expr):
            return label
    return None


def expr_status(expr: str, tainted: dict):
    if not expr:
        return "unknown", ""
    if SANITIZER_RE.search(expr):
        return "sanitized", ""
    label = source_label(expr, tainted)
    if label:
        return "tainted", label
    if LITERAL_RE.match(expr):
        return "constant", ""
    return "unknown", ""


def collect_tainted(masked: str):
    tainted = {}
    for _ in range(5):
        changed = False
        for regex, is_declaration in (
            (ASSIGN_DECL_RE, True),
            (ASSIGN_PLAIN_RE, False),
        ):
            for match in regex.finditer(masked):
                name, rhs = match.group(1), match.group(2)
                if not is_declaration and name.lower() in PROPERTY_NAMES:
                    continue
                label = source_label(rhs, tainted)
                if label and name not in tainted:
                    tainted[name] = label
                    changed = True
        if not changed:
            break
    return tainted


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Rule:
    id: str
    name: str
    pattern: str
    severity: str
    kind: str
    advice: str
    extractor: str = "rhs"
    arg_index: int = 0
    match_original: bool = False


RULES = [
    # HTML parsing sinks
    Rule("inner-html", "HTML sink: innerHTML/outerHTML",
         r"\.\s*(?:inner|outer)HTML\s*(?:\+)?=(?!=)",
         "medium", "sink",
         "Trace the assigned value back to an attacker-controlled source."),
    Rule("inner-html-bracket", "HTML sink: bracket innerHTML/outerHTML",
         r"\[\s*['\"](?:inner|outer)HTML['\"]\s*\]\s*=",
         "medium", "sink",
         "Bracket access still parses HTML. Trace the assigned value.", match_original=True),
    Rule("insert-adjacent-html", "HTML sink: insertAdjacentHTML",
         r"\.\s*insertAdjacentHTML\s*\(",
         "medium", "sink",
         "Inspect the second argument and its source.", "arg", 1),
    Rule("document-write", "HTML sink: document.write/writeln",
         r"\bdocument\s*\.\s*write(?:ln)?\s*\(",
         "medium", "sink",
         "Check whether arguments contain attacker-controlled values.", "arg", 0),
    Rule("srcdoc-assign", "HTML sink: srcdoc assignment",
         r"\.\s*srcdoc\s*=",
         "high", "sink",
         "srcdoc parses HTML. Never assign untrusted data."),
    Rule("range-fragment", "HTML sink: Range.createContextualFragment",
         r"createContextualFragment\s*\(",
         "high", "sink",
         "The fragment parses HTML. Trace its argument.", "arg", 0),
    Rule("domparser-html", "HTML sink: DOMParser text/html",
         r"new\s+DOMParser\s*\(\s*\)\s*\.\s*parseFromString\s*\(",
         "medium", "sink",
         "Parsed HTML is inert only until it is inserted; check the insertion.",
         "arg", 0),
    Rule("create-html-document", "HTML sink: createHTMLDocument",
         r"createHTMLDocument\s*\(",
         "medium", "sink",
         "Check how the created document is populated and inserted.",
         "arg", 0),
    Rule("set-html-api", "HTML sink: Element.setHTML",
         r"\.\s*setHTML\s*\(",
         "medium", "sink",
         "setHTML sanitizes only if a trust policy is configured. Verify it.",
         "arg", 0),
    Rule("jquery-html", "jQuery HTML sink: .html()",
         r"\.\s*html\s*\(",
         "medium", "sink",
         "jQuery .html() parses HTML. Inspect the argument.", "arg", 0),
    Rule("jquery-insert", "jQuery insertion sink",
         r"\.\s*(?:append|prepend|before|after|replaceWith|wrap|wrapInner|"
         r"appendTo|prependTo|insertAfter|insertBefore)\s*\(",
         "low", "sink",
         "These methods parse HTML strings in jQuery. Check the receiver and argument.",
         "arg", 0),
    Rule("jquery-parse-html", "jQuery parseHTML",
         r"(?:\$|jQuery)\s*\.\s*parseHTML\s*\(",
         "high", "sink",
         "parseHTML creates DOM nodes from a string.", "arg", 0),
    Rule("jquery-global-eval", "jQuery globalEval",
         r"(?:\$|jQuery)\s*\.\s*globalEval\s*\(",
         "high", "sink",
         "globalEval executes its argument as code.", "arg", 0),
    Rule("jquery-get-script", "jQuery getScript",
         r"(?:\$|jQuery)\s*\.\s*getScript\s*\(",
         "medium", "sink",
         "getScript loads and executes same-origin scripts.", "arg", 0),

    # Code sinks
    Rule("eval", "Code sink: eval",
         r"(?<![\w$.])(?:eval|window\s*\.\s*eval|globalThis\s*\.\s*eval)\s*\(",
         "high", "sink",
         "Check whether untrusted data reaches eval.", "arg", 0),
    Rule("function-constructor", "Code sink: Function constructor",
         r"\b(?:new\s+)?Function\s*\(",
         "high", "sink",
         "The last argument is executable code.", "arglast"),
    Rule("set-timeout", "Code sink: setTimeout(string)",
         r"\bsetTimeout\s*\(",
         "medium", "sink",
         "A string first argument is compiled as code.", "arg", 0),
    Rule("set-interval", "Code sink: setInterval(string)",
         r"\bsetInterval\s*\(",
         "medium", "sink",
         "A string first argument is compiled as code.", "arg", 0),
    Rule("import-scripts", "Code sink: importScripts",
         r"\bimportScripts\s*\(",
         "high", "sink",
         "importScripts executes scripts in the worker scope.", "arg", 0),

    # Attribute / URL sinks
    Rule("set-attribute-on", "Event handler sink: setAttribute(on*)",
         r"\.\s*setAttribute\s*\(\s*['\"]on[a-z]+['\"]\s*,",
         "high", "sink",
         "Dynamic inline handlers are executable.", "arg", 1, match_original=True),
    Rule("set-attribute-srcdoc", "HTML sink: setAttribute(srcdoc)",
         r"\.\s*setAttribute\s*\(\s*['\"]srcdoc['\"]\s*,",
         "high", "sink",
         "srcdoc parses HTML.", "arg", 1, match_original=True),
    Rule("set-attribute-url", "URL sink: setAttribute(href/src/action)",
         r"\.\s*setAttribute\s*\(\s*['\"](?:href|src|action|formaction|"
         r"xlink:href)['\"]\s*,",
         "high", "sink",
         "A javascript: URL here executes when followed.", "arg", 1, match_original=True),
    Rule("location-assign", "URL sink: location assignment",
         r"(?:window\s*\.\s*)?location\s*(?:\.\s*(?:href|assign|replace))?\s*=",
         "high", "sink",
         "A javascript: URL here executes. Validate the scheme first."),
    Rule("window-open", "URL sink: window.open",
         r"\bwindow\s*\.\s*open\s*\(",
         "medium", "sink",
         "A javascript: URL or attacker-chosen destination may execute or phish.",
         "arg", 0),
    Rule("javascript-uri", "URL sink: javascript: URI literal",
         r"javascript\s*:",
         "high", "sink",
         "This URI executes code when followed.", "none", match_original=True),
    Rule("script-src-assign", "Script sink: script.src assignment",
         r"\.\s*src\s*=",
         "medium", "sink",
         "Check whether the element is a script and the value is attacker-controlled."),
    Rule("object-data-assign", "HTML sink: object.data assignment",
         r"\.\s*data\s*=",
         "low", "sink",
         "Check whether the element is an object/embed and the value is a URL."),

    # Framework-specific sinks
    Rule("react-dangerous", "Framework sink: dangerouslySetInnerHTML",
         r"dangerouslySetInnerHTML",
         "high", "sink",
         "React will inject __html without escaping.", "__html"),
    Rule("astro-set-html", "Framework sink: Astro set:html",
         r"set\s*:\s*html\s*=",
         "high", "sink",
         "Astro's set:html injects raw HTML.", "brace"),
    Rule("vue-v-html", "Framework sink: Vue v-html",
         r"\bv-html\s*=",
         "high", "sink",
         "v-html injects raw HTML.", "attr"),
    Rule("svelte-html", "Framework sink: Svelte {@html}",
         r"\{@html\b",
         "high", "sink",
         "Svelte {@html} injects raw HTML.", "brace"),
    Rule("angular-bypass", "Framework sink: Angular bypassSecurityTrustHtml",
         r"bypassSecurityTrustHtml\s*\(",
         "high", "sink",
         "This explicitly bypasses Angular's sanitizer.", "arg", 0),
    Rule("lit-unsafe-html", "Framework sink: unsafeHTML",
         r"\bunsafeHTML\s*\(",
         "high", "sink",
         "lit's unsafeHTML injects raw HTML.", "arg", 0),
    Rule("leaflet-popup", "HTML sink: Leaflet popup/tooltip HTML",
         r"\.\s*(?:bindPopup|bindTooltip|setContent|bindLabel)\s*\(",
         "medium", "sink",
         "Leaflet parses HTML in these methods. Ensure every interpolation is escaped.",
         "arg", 0),
    Rule("postmessage-star", "postMessage with wildcard target origin",
         r"\.\s*postMessage\s*\([^)]*,\s*['\"]\*['\"]\s*\)",
         "info", "sink",
         "Wildcard targetOrigin leaks messages to any origin. Pin the receiver origin.",
         "none", match_original=True),
    Rule("object-assign-innerhtml", "HTML sink: Object.assign innerHTML",
         r"innerHTML\s*:",
         "medium", "sink",
         "Object.assign can set innerHTML without a direct assignment."),

    # Sources
    Rule("source-location", "Source: location",
         r"location\s*\.\s*(?:search|hash|href|pathname|ancestorOrigins)",
         "info", "source",
         "A source alone is not a vulnerability. Trace it to a sink."),
    Rule("source-document", "Source: document URL/referrer/cookie",
         r"document\s*\.\s*(?:URL|documentURI|referrer|cookie|baseURI)",
         "info", "source",
         "Trace document-derived data into a sink."),
    Rule("source-window-name", "Source: window.name",
         r"window\s*\.\s*name",
         "info", "source",
         "window.name is attacker-controlled across navigations."),
    Rule("source-window-opener", "Source: window.opener",
         r"window\s*\.\s*opener",
         "info", "source",
         "opener data is cross-origin controlled."),
    Rule("source-urlsearchparams", "Source: URLSearchParams",
         r"URLSearchParams",
         "info", "source",
         "URLSearchParams is a source; trace the extracted values."),
    Rule("source-storage", "Source: localStorage/sessionStorage",
         r"(?:localStorage|sessionStorage)\s*(?:\.\s*\w+|\.\s*(?:getItem|key)\s*\()",
         "info", "source",
         "Trace stored values into HTML or code sinks."),
    Rule("source-history-state", "Source: history.state",
         r"history\s*\.\s*state",
         "info", "source",
         "Navigation state can carry attacker-controlled data."),
    Rule("source-message-listener", "Source: message event",
         r"(?:addEventListener\s*\(\s*['\"]message['\"]|"
         r"\.\s*onmessage\s*=|window\s*\.\s*onmessage)",
         "info", "source",
         "Check origin validation and whether message data reaches a sink.", match_original=True),
    Rule("source-form-value", "Source: form field value",
         r"(?:event|e|evt)\s*\.\s*target[^;\n]{0,120}\.value\b",
         "info", "source",
         "Form values are attacker-controlled. Trace them into a sink."),
    Rule("source-event-data", "Source: event.data",
         r"(?:event|e|evt|msg|message)\s*\.\s*data\b",
         "info", "source",
         "Message data is attacker-controlled unless origin is checked."),
    Rule("source-clipboard", "Source: clipboard/drag data",
         r"(?:clipboardData|dataTransfer)\s*\.\s*getData\s*\(",
         "info", "source",
         "Clipboard and drag data can carry HTML."),
    Rule("source-filereader", "Source: FileReader result",
         r"(?:FileReader|reader)\s*\.\s*result\b",
         "info", "source",
         "File contents can contain HTML."),
    Rule("source-postmessage", "Source: postMessage",
         r"\.\s*postMessage\s*\(",
         "info", "source",
         "Check the receiver, origin, and whether data reaches a sink."),
    Rule("source-broadcast", "Source: BroadcastChannel/MessageChannel",
         r"(?:BroadcastChannel|MessageChannel|SharedWorker)",
         "info", "source",
         "Cross-context messages are attacker-controlled if the channel is shared."),
]

COMPILED_RULES = [
    (rule, re.compile(rule.pattern, re.M)) for rule in RULES
]

SOURCE_PATTERNS = [
    rule.pattern for rule in RULES if rule.kind == "source"
]
SOURCE_RE = re.compile("|".join(f"(?:{p})" for p in SOURCE_PATTERNS), re.M)

HTML_URL_ATTRS = ("href", "src", "action", "formaction", "xlink:href", "data")
HTML_EVENT_RE = re.compile(r"^on[a-z]+$", re.I)


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


class PageParser(HTMLParser):
    """Extract scripts, links, forms, frames, and every start-tag attribute."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.scripts = []
        self.links = []
        self.forms = []
        self.iframes = []
        self.attrs = []
        self.base_href = None
        self.text_parts = []
        self.in_script = False
        self.script_src = None
        self.script_parts = []
        self.script_start_line = 1
        self.script_type = ""
        self._current_form = None

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        line = self.getpos()[0]
        values = dict(attrs)
        for name, value in attrs:
            self.attrs.append({
                "tag": tag,
                "name": (name or "").lower(),
                "value": value or "",
                "line": line,
            })
        if tag == "script":
            self.in_script = True
            self.script_src = values.get("src")
            self.script_type = (values.get("type") or "").lower()
            self.script_parts = []
            self.script_start_line = line
        elif tag == "base" and values.get("href"):
            self.base_href = values["href"]
        elif tag in ("a", "area") and values.get("href"):
            self.links.append({"href": values["href"], "line": line})
        elif tag == "form":
            self._current_form = {
                "action": values.get("action") or "",
                "method": (values.get("method") or "get").lower(),
                "line": line,
                "fields": [],
            }
            self.forms.append(self._current_form)
        elif tag in ("input", "textarea", "select"):
            if self._current_form is not None:
                self._current_form["fields"].append({
                    "tag": tag,
                    "name": values.get("name") or "",
                    "type": (values.get("type") or "text").lower(),
                    "value": values.get("value") or "",
                    "line": line,
                })
        elif tag == "iframe":
            self.iframes.append({
                "src": values.get("src") or "",
                "srcdoc": values.get("srcdoc") or "",
                "line": line,
            })

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_data(self, data):
        if self.in_script:
            self.script_parts.append(data)
        else:
            self.text_parts.append(data)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag == "script" and self.in_script:
            self.scripts.append({
                "src": self.script_src,
                "type": getattr(self, "script_type", ""),
                "text": "".join(self.script_parts),
                "line": self.script_start_line,
            })
            self.in_script = False
            self.script_src = None
            self.script_parts = []
        elif tag == "form":
            self._current_form = None


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------


def build_ssl_context(args):
    if args.insecure:
        return ssl._create_unverified_context()
    if getattr(args, "cacert", None):
        return ssl.create_default_context(cafile=args.cacert)
    try:
        import certifi  # type: ignore
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    for candidate in (
        "/etc/ssl/cert.pem",
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
    ):
        if os.path.exists(candidate):
            try:
                return ssl.create_default_context(cafile=candidate)
            except Exception:
                pass
    return ssl.create_default_context()


def fetch(url, args, headers, cookie, max_bytes=None):
    max_bytes = max_bytes or args.max_bytes
    request_headers = {
        "User-Agent": args.user_agent or USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/javascript,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
    }
    request_headers.update(headers or {})
    if cookie:
        request_headers.setdefault("Cookie", cookie)
    request = Request(url, headers=request_headers)
    try:
        with urlopen(
            request,
            timeout=args.timeout,
            context=build_ssl_context(args),
        ) as response:
            raw = response.read(max_bytes + 1)
            truncated = len(raw) > max_bytes
            raw = raw[:max_bytes]
            charset = response.headers.get_content_charset() or "utf-8"
            try:
                body = raw.decode(charset, errors="replace")
            except LookupError:
                body = raw.decode("utf-8", errors="replace")
            return {
                "url": response.geturl(),
                "status": getattr(response, "status", None),
                "type": response.headers.get("Content-Type", ""),
                "headers": dict(response.headers.items()),
                "body": body,
                "truncated": truncated,
                "error": None,
            }
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, ssl.SSLError) as exc:
        status = exc.code if isinstance(exc, HTTPError) else None
        return {
            "url": url,
            "status": status,
            "type": "",
            "headers": {},
            "body": "",
            "truncated": False,
            "error": f"{type(exc).__name__}: {exc}",
        }


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------


def make_finding(
    url, source_type, line, rule, severity, confidence,
    match, snippet, advice, source_name="", flow="", kind="sink",
):
    return {
        "url": redact_url(url),
        "source_type": source_type,
        "source_name": source_name,
        "line": line,
        "rule_id": rule.id if isinstance(rule, Rule) else str(rule),
        "rule": rule.name if isinstance(rule, Rule) else str(rule),
        "kind": kind,
        "severity": severity,
        "confidence": confidence,
        "match": match[:180],
        "snippet": snippet,
        "advice": advice,
        "flow": flow,
    }


def extract_param_names(text):
    names = set()
    for match in re.finditer(
        r"""(?:searchParams|params|query|URLSearchParams)"""
        r"""[^;\n]{0,120}?\.get\(\s*['"]([^'"]+)['"]""",
        text,
    ):
        names.add(match.group(1))
    return names


def analyze_js(text, url, source_type, base_line=1, source_name="", include_sources=False):
    findings = []
    if not text:
        return findings
    masked = mask_js(text)
    tainted = collect_tainted(masked)

    for rule, regex in COMPILED_RULES:
        haystack = text if rule.match_original else masked
        for match in regex.finditer(haystack):
            expr = ""
            if rule.extractor == "rhs":
                expr = extract_rhs(text, match)
            elif rule.extractor == "arg":
                args = extract_args(text, match)
                if rule.arg_index < len(args):
                    expr = args[rule.arg_index]
            elif rule.extractor == "arglast":
                args = extract_args(text, match)
                if args:
                    expr = args[-1]
            elif rule.extractor == "__html":
                tail = text[match.start():match.start() + 500]
                found = re.search(r"__html\s*:\s*([^,}]+)", tail, re.S)
                expr = found.group(1).strip() if found else ""
            elif rule.extractor == "brace":
                expr = extract_braced(text, match)
            elif rule.extractor == "attr":
                expr = extract_attr_value(text, match)

            label = ""
            if rule.kind == "source":
                if not include_sources:
                    continue
                severity, confidence = "info", "source"
            else:
                status, label = expr_status(expr, tainted)
                if status == "constant":
                    severity, confidence = "info", "constant"
                elif status == "sanitized":
                    severity, confidence = "low", "sanitized"
                elif status == "tainted":
                    severity, confidence = rule.severity, "tainted"
                else:
                    severity, confidence = rule.severity, "unknown"
                if rule.id in (
                    "astro-set-html", "vue-v-html", "svelte-html",
                    "react-dangerous", "lit-unsafe-html",
                ) and status == "unknown":
                    severity = "medium"
                if rule.id == "window-open" and (expr or "").strip() in ("''", '""'):
                    continue
                if rule.id in ("eval", "function-constructor") and status == "sanitized":
                    severity, confidence = "high", "sanitized-input"
                if rule.id in ("location-assign", "set-attribute-url", "window-open"):
                    if "javascript:" in (expr or "").lower():
                        severity, confidence = "high", "literal-javascript-uri"
                    elif status in ("unknown", "constant"):
                        severity = "medium"
                if rule.id in ("set-timeout", "set-interval"):
                    stripped = (expr or "").strip()
                    if re.match(
                        r"^(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|"
                        r"[A-Za-z_$][\w$]*\s*=>|[A-Za-z_$][\w$]*$)",
                        stripped,
                    ):
                        continue
                    if status == "tainted":
                        severity, confidence = "high", "tainted"
                    elif stripped.startswith(("'", '"', "`")):
                        severity, confidence = "high", "string-code"
                    else:
                        severity, confidence = "low", "unknown"
                if rule.id == "jquery-insert":
                    receiver = text[max(0, match.start() - 100):match.start()].lower()
                    if any(safe in receiver for safe in SAFE_RECEIVERS):
                        continue
                if rule.id == "script-src-assign":
                    receiver = text[max(0, match.start() - 100):match.start()].lower()
                    if re.search(
                        r"(?:img|image|video|audio|poster|source|iframe|embed|object)$",
                        receiver.strip(),
                    ):
                        continue

            findings.append(make_finding(
                url=url,
                source_type=source_type,
                line=base_line + line_number(text, match.start()) - 1,
                rule=rule,
                severity=severity,
                confidence=confidence,
                match=text[match.start():match.end()],
                snippet=snippet_at(text, match.start()),
                advice=rule.advice,
                source_name=source_name,
                flow=label,
                kind=rule.kind,
            ))
    return dedupe_findings(findings)


def analyze_html(url, body, parser: PageParser, source_name="", include_sources=False):
    findings = []
    for attr in parser.attrs:
        name = attr["name"]
        value = attr["value"]
        tag = attr["tag"]
        line = attr["line"]
        name_lower = name.lower()
        value_lower = value.strip().lower()

        if HTML_EVENT_RE.match(name_lower) and value.strip():
            findings.append(make_finding(
                url, "html-attribute", line, "inline-event-handler",
                "medium", "inline-handler",
                f"{name}={value[:120]}",
                f"<{tag} {name}=\"{value[:300]}\">",
                "Inline event handlers execute. Move logic to an external script.",
                source_name=source_name,
            ))
            findings.extend(analyze_js(
                value, url, "inline-handler-js",
                base_line=line, source_name=source_name,
                include_sources=include_sources,
            ))
        if name_lower == "srcdoc" and value.strip():
            findings.append(make_finding(
                url, "html-attribute", line, "srcdoc-attribute",
                "high", "html-attribute",
                f"srcdoc={value[:120]}",
                f"<{tag} srcdoc=\"{value[:300]}\">",
                "srcdoc parses HTML. Never use untrusted data here.",
                source_name=source_name,
            ))
            nested = PageParser()
            try:
                nested.feed(value)
                findings.extend(analyze_html(
                    f"{url}#srcdoc", value, nested, source_name=source_name,
                    include_sources=include_sources,
                ))
            except Exception:
                pass
        if name_lower in HTML_URL_ATTRS and value_lower.startswith("javascript:"):
            findings.append(make_finding(
                url, "html-attribute", line, "javascript-url-attribute",
                "high", "html-attribute",
                f"{name}={value[:120]}",
                f"<{tag} {name}=\"{value[:300]}\">",
                "A javascript: URL executes when followed.",
                source_name=source_name,
            ))
        if name_lower in ("data", "src") and value_lower.startswith("data:text/html"):
            findings.append(make_finding(
                url, "html-attribute", line, "data-html-attribute",
                "medium", "html-attribute",
                f"{name}={value[:120]}",
                f"<{tag} {name}=\"{value[:300]}\">",
                "data:text/html can execute when navigated or embedded.",
                source_name=source_name,
            ))
        if tag == "meta" and name_lower == "content" and "javascript:" in value_lower:
            findings.append(make_finding(
                url, "html-attribute", line, "meta-refresh-javascript",
                "high", "html-attribute",
                f"content={value[:120]}",
                f"<meta content=\"{value[:300]}\">",
                "A meta refresh to javascript: executes code.",
                source_name=source_name,
            ))
        if name_lower == "style" and "expression(" in value_lower:
            findings.append(make_finding(
                url, "html-attribute", line, "css-expression",
                "low", "html-attribute",
                f"style={value[:120]}",
                f"<{tag} style=\"{value[:300]}\">",
                "Legacy CSS expression() executes script in old IE.",
                source_name=source_name,
            ))

    for script in parser.scripts:
        if script["src"]:
            continue
        script_type = (script.get("type") or "").lower()
        if "json" in script_type or "template" in script_type or "text/plain" in script_type:
            continue
        findings.extend(analyze_js(
            script["text"], url, "inline-javascript",
            base_line=script["line"], source_name=source_name,
            include_sources=include_sources,
        ))
    return dedupe_findings(findings)


def dedupe_findings(findings):
    deduped, seen = [], set()
    for finding in findings:
        key = (
            finding["url"], finding["source_type"], finding["line"],
            finding["rule_id"], finding["match"], finding["snippet"],
        )
        if key not in seen:
            seen.add(key)
            deduped.append(finding)
    return deduped


def sort_findings(findings):
    rank = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    return sorted(
        findings,
        key=lambda f: (
            rank.get(f["severity"], 5),
            0 if f["confidence"] == "tainted" else 1,
            f["url"],
            f["line"],
        ),
    )


# ---------------------------------------------------------------------------
# Static crawl
# ---------------------------------------------------------------------------


def parse_source_map(body, asset_url):
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return []
    sources = data.get("sources") or []
    contents = data.get("sourcesContent") or []
    out = []
    for index, content in enumerate(contents):
        if not content:
            continue
        name = sources[index] if index < len(sources) else f"source-{index}"
        out.append((name, content))
    return out


def discover_js_assets(text, base_url, allowed_origin):
    urls = set()
    patterns = [
        r"""import\s*\(\s*['"]([^'"]+)['"]\s*\)""",
        r"""new\s+Worker\s*\(\s*(?:new\s+URL\s*\(\s*)?['"]([^'"]+)['"]""",
        r"""serviceWorker\s*\.\s*register\s*\(\s*['"]([^'"]+)['"]""",
        r"""importScripts\s*\(\s*['"]([^'"]+)['"]""",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, text):
            candidate = allowed_url(match.group(1), base_url, allowed_origin)
            if candidate and (
                urlparse(candidate).path.lower().endswith(JS_EXTENSIONS)
                or "worker" in candidate.lower()
            ):
                urls.add(candidate)
    for match in re.finditer(r"""['"]([^'"]+\.(?:js|mjs))['"]""", text):
        if len(urls) >= 200:
            break
        candidate = allowed_url(match.group(1), base_url, allowed_origin)
        if candidate:
            urls.add(candidate)
    return urls


def source_map_url(text, asset_url):
    match = re.search(r"sourceMappingURL=([^\s*]+)", text)
    if not match:
        return None
    candidate = urljoin(asset_url, match.group(1).strip())
    parsed = urlparse(candidate)
    if parsed.scheme.lower() not in ("http", "https"):
        return None
    if origin(candidate) != origin(asset_url):
        return None
    if parsed.username or parsed.password:
        return None
    return candidate


def static_scan(args, headers, cookie):
    start = normalize(args.url, keep_query=True, keep_hash=False)
    allowed = origin(start)
    if allowed is None:
        raise RuntimeError(f"Invalid starting URL: {args.url}")

    queue = deque([start])
    queued = {start}
    visited_pages = set()
    visited_assets = set()
    pages, assets, findings, warnings = [], [], [], []
    csp_by_url = {}
    param_names = set()

    while queue and len(visited_pages) < args.max_pages:
        page_url = queue.popleft()
        if page_url in visited_pages:
            continue
        if any(re.search(rx, page_url) for rx in args.exclude_url):
            continue
        visited_pages.add(page_url)
        if args.delay:
            time.sleep(max(0.0, args.delay))

        page = fetch(page_url, args, headers, cookie)
        pages.append({
            "url": redact_url(page["url"]),
            "status": page["status"],
            "type": page["type"],
            "truncated": page["truncated"],
            "error": page["error"],
        })
        if not args.quiet:
            print(f"[PAGE] {page['status'] or 'ERR'} {redact_url(page['url'])}")

        if page["error"]:
            warnings.append(f"Page fetch failed: {redact_url(page_url)}: {page['error']}")
            continue
        if origin(page["url"]) != allowed:
            warnings.append(f"Redirected off-origin, skipped: {redact_url(page_url)} -> {redact_url(page['url'])}")
            continue
        if page["truncated"]:
            warnings.append(f"Page truncated at {args.max_bytes} bytes: {redact_url(page_url)}")
        body = page["body"]
        if not is_html_type(page["type"]) and not (
            not page["type"] and body.lstrip().startswith("<")
        ):
            warnings.append(f"Non-HTML page skipped: {redact_url(page_url)} ({page['type'] or 'no content-type'})")
            continue

        csp = ""
        for header_name, header_value in (page["headers"] or {}).items():
            if header_name.lower() == "content-security-policy":
                csp = header_value
                break
        if not csp:
            meta_csp = re.search(
                r"""<meta[^>]+http-equiv=["']content-security-policy["'][^>]+content=["']([^"']+)""",
                body, re.I,
            )
            if meta_csp:
                csp = meta_csp.group(1)
        csp_by_url[redact_url(page["url"])] = csp
        parser = PageParser()
        try:
            parser.feed(body)
        except Exception as exc:
            warnings.append(f"HTML parse warning for {redact_url(page_url)}: {exc}")

        param_names.update(extract_param_names(body))
        findings.extend(analyze_html(
            page["url"], body, parser,
            include_sources=args.include_sources,
        ))

        base = urljoin(page["url"], parser.base_href) if parser.base_href else page["url"]

        asset_candidates = []
        for script in parser.scripts:
            if script["src"]:
                asset_candidates.append(script["src"])
        for attr in parser.attrs:
            if attr["tag"] == "link" and attr["name"] == "href":
                rel = ""
                as_type = ""
                for other in parser.attrs:
                    if other["line"] == attr["line"] and other["tag"] == "link":
                        if other["name"] == "rel":
                            rel = other["value"].lower()
                        if other["name"] == "as":
                            as_type = other["value"].lower()
                if "modulepreload" in rel or ("preload" in rel and as_type == "script"):
                    asset_candidates.append(attr["value"])

        for candidate in asset_candidates:
            asset_url = allowed_url(candidate, base, allowed)
            if not asset_url or asset_url in visited_assets:
                continue
            if any(re.search(rx, asset_url) for rx in args.exclude_url):
                continue
            if len(visited_assets) >= args.max_assets:
                continue
            visited_assets.add(asset_url)
            if args.delay:
                time.sleep(max(0.0, args.delay))
            asset = fetch(asset_url, args, headers, cookie)
            assets.append({
                "url": redact_url(asset["url"]),
                "status": asset["status"],
                "type": asset["type"],
                "truncated": asset["truncated"],
                "error": asset["error"],
            })
            if not args.quiet:
                print(f"  [JS] {asset['status'] or 'ERR'} {redact_url(asset['url'])}")
            if asset["error"]:
                warnings.append(f"JS fetch failed: {redact_url(asset_url)}: {asset['error']}")
                continue
            if asset["truncated"]:
                warnings.append(f"JS truncated at {args.max_bytes} bytes: {redact_url(asset_url)}")
            if not (is_javascript_type(asset["type"]) or
                    urlparse(asset["url"]).path.lower().endswith(JS_EXTENSIONS)):
                warnings.append(f"Non-JS asset skipped: {redact_url(asset_url)} ({asset['type']})")
                continue
            param_names.update(extract_param_names(asset["body"]))
            findings.extend(analyze_js(
                asset["body"], asset["url"], "javascript",
                include_sources=args.include_sources,
            ))

            for chunk in discover_js_assets(asset["body"], asset["url"], allowed):
                if (
                    chunk not in visited_assets
                    and chunk not in asset_candidates
                    and len(visited_assets) < args.max_assets
                ):
                    asset_candidates.append(chunk)

            map_url = source_map_url(asset["body"], asset["url"])
            if map_url:
                source_map = fetch(map_url, args, headers, cookie)
                if not source_map["error"]:
                    for name, content in parse_source_map(source_map["body"], asset["url"]):
                        param_names.update(extract_param_names(content))
                        findings.extend(analyze_js(
                            content, asset["url"], "sourcemap",
                            source_name=name,
                            include_sources=args.include_sources,
                        ))

        for link in parser.links:
            href = link["href"].strip()
            if not href or href.startswith("#") or href.lower().startswith("javascript:"):
                continue
            candidate = allowed_url(href, base, allowed)
            if not candidate:
                continue
            parsed = urlparse(candidate)
            if not args.include_query_links and parsed.query:
                candidate = urlunparse((parsed.scheme, parsed.netloc, parsed.path or "/", "", "", ""))
            candidate = normalize(candidate, keep_query=args.include_query_links, keep_hash=False)
            if candidate not in queued and candidate not in visited_pages and len(queued) < args.max_pages * 20:
                queued.add(candidate)
                queue.append(candidate)

        for frame in parser.iframes:
            if not frame["src"]:
                continue
            candidate = allowed_url(frame["src"], base, allowed)
            if candidate:
                candidate = normalize(candidate, keep_query=True, keep_hash=False)
            if candidate and candidate not in queued and candidate not in visited_pages:
                queued.add(candidate)
                queue.append(candidate)

    findings = sort_findings(dedupe_findings(findings))
    return {
        "pages": pages,
        "assets": assets,
        "findings": findings,
        "csp": csp_by_url,
        "param_names": sorted(param_names),
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Local source scan
# ---------------------------------------------------------------------------


def source_scan(paths, args):
    findings, warnings, files = [], [], []
    excludes = set(split_csv(args.source_exclude))
    for raw_path in paths:
        root = Path(raw_path).expanduser().resolve()
        if not root.exists():
            warnings.append(f"Source path does not exist: {raw_path}")
            continue
        if root.is_file():
            candidates = [root]
        else:
            candidates = []
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [
                    d for d in dirnames
                    if d not in excludes and not d.startswith(".git")
                ]
                for filename in filenames:
                    candidates.append(Path(dirpath) / filename)
        for path in candidates:
            if path.suffix.lower() not in SOURCE_EXTENSIONS:
                continue
            try:
                if path.stat().st_size > args.max_bytes:
                    warnings.append(f"Source file truncated: {path}")
                text = read_text(path, args.max_bytes)
            except OSError as exc:
                warnings.append(f"Unable to read {path}: {exc}")
                continue
            files.append(str(path))
            if path.suffix.lower() in PAGE_EXTENSIONS:
                parser = PageParser()
                try:
                    parser.feed(text)
                except Exception:
                    pass
                findings.extend(analyze_html(
                    str(path), text, parser, source_name=str(path),
                    include_sources=args.include_sources,
                ))
            else:
                findings.extend(analyze_js(
                    text, str(path), "source-file",
                    source_name=str(path),
                    include_sources=args.include_sources,
                ))
    findings = sort_findings(dedupe_findings(findings))
    return {
        "files": files,
        "findings": findings,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Dynamic payloads
# ---------------------------------------------------------------------------


def build_payloads(args):
    payloads = [
        {
            "id": "html_img",
            "context": "html",
            "value": f"<img src=x onerror=\"{MARK}('html_img')\">",
        },
        {
            "id": "html_svg",
            "context": "html",
            "value": f"<svg onload=\"{MARK}('html_svg')\"></svg>",
        },
        {
            "id": "attr_breakout",
            "context": "attribute",
            "value": f"\"><img src=x onerror=\"{MARK}('attr_breakout')\">",
        },
        {
            "id": "js_single",
            "context": "javascript-string",
            "value": f"';{MARK}('js_single');//",
        },
        {
            "id": "js_double",
            "context": "javascript-string",
            "value": f"\";{MARK}('js_double');//",
        },
        {
            "id": "template",
            "context": "template-literal",
            "value": f"`;{MARK}('template');//",
        },
        {
            "id": "code",
            "context": "code",
            "value": f"{MARK}('code')",
        },
        {
            "id": "url",
            "context": "url",
            "value": f"javascript:{MARK}('url')",
        },
        {
            "id": "srcdoc",
            "context": "html",
            "value": (
                f"<iframe srcdoc=\"<script>parent.{MARK}('srcdoc')</script>\">"
                f"</iframe>"
            ),
        },
        {
            "id": "details",
            "context": "html",
            "value": f"<details open ontoggle=\"{MARK}('details')\">",
        },
        {
            "id": "focus",
            "context": "html",
            "value": f"<input autofocus onfocus=\"{MARK}('focus')\">",
        },
        {
            "id": "mxss",
            "context": "html",
            "value": (
                f"<math><mtext><table><mglyph><style><!--</style>"
                f"<img title=\"--><img src=x onerror=\"{MARK}('mxss')\">\">"
            ),
        },
        {
            "id": "body_onload",
            "context": "html",
            "value": f"<body onload=\"{MARK}('body_onload')\">",
        },
    ]
    if getattr(args, "payloads", "full") == "basic":
        keep = {"html_img", "attr_breakout", "js_single", "url", "code"}
        return [item for item in payloads if item["id"] in keep]
    return payloads


def build_init_script(args) -> str:
    token = json.dumps(getattr(args, "auth_token", "") or "")
    key = json.dumps(getattr(args, "auth_storage_key", "") or "")
    seed = ""
    if getattr(args, "auth_token", None) and getattr(args, "auth_storage_key", None):
        seed = (
            f"try {{ localStorage.setItem({key}, {token}); }} "
            f"catch (e) {{}}"
        )
    script = r"""
(() => {
  const state = {
    hits: [],
    dialogs: [],
    errors: [],
    csp: []
  };
  window.__domxss = state;

  const record = (kind, detail) => {
    try {
      if (state.hits.length < 100) {
        state.hits.push({
          kind: String(kind),
          detail: String(detail || '').slice(0, 500),
          url: location.href,
          ts: Date.now()
        });
      }
      if (document.documentElement) {
        document.documentElement.setAttribute('data-domxss', String(kind));
      }
    } catch (e) {}
  };
  window.__domxss_mark = record;

  for (const name of ['alert', 'confirm', 'prompt']) {
    try {
      window[name] = function (message) {
        record(name, message);
        if (name === 'confirm') return false;
        if (name === 'prompt') return null;
        return undefined;
      };
    } catch (e) {}
  }

  try {
    document.addEventListener('securitypolicyviolation', event => {
      state.csp.push({
        directive: event.effectiveDirective || '',
        blockedURI: event.blockedURI || '',
        sample: String(event.sample || '').slice(0, 300)
      });
    });
  } catch (e) {}

  try {
    window.addEventListener('error', event => {
      state.errors.push(String(event.message || '').slice(0, 300));
    });
  } catch (e) {}

  __SEED__
})();
"""
    return script.replace("__SEED__", seed)


def parse_csp(csp: str) -> dict:
    directives = {}
    for part in (csp or "").split(";"):
        tokens = part.strip().split()
        if not tokens:
            continue
        directives[tokens[0].lower()] = tokens[1:]
    script = directives.get("script-src") or directives.get("default-src") or []
    joined = " ".join(script).lower()
    frame_src = " ".join(directives.get("frame-src", [])).lower()
    has_policy = bool((csp or "").strip())
    return {
        "raw": csp or "",
        "script_src": script,
        "frame_src": frame_src,
        "unsafe_inline": "'unsafe-inline'" in joined,
        "unsafe_eval": "'unsafe-eval'" in joined,
        "has_nonce": "'nonce-" in joined,
        "has_hash": "'sha256-" in joined or "'sha384-" in joined or "'sha512-" in joined,
        "blocks_inline": has_policy and "'unsafe-inline'" not in joined,
        "blocks_eval": has_policy and "'unsafe-eval'" not in joined,
        "blocks_frames": "'none'" in frame_src,
    }


def get_csp(page, response) -> str:
    header_value = ""
    if response is not None:
        try:
            headers = response.headers
            for key, value in headers.items():
                if key.lower() == "content-security-policy":
                    header_value = value
                    break
        except Exception:
            pass
    meta_value = ""
    try:
        meta_value = page.evaluate("""() => {
          const meta = Array.from(document.querySelectorAll('meta[http-equiv]'))
            .find(item => String(item.httpEquiv || '').toLowerCase() === 'content-security-policy');
          return meta ? (meta.content || '') : '';
        }""")
    except Exception:
        pass
    if header_value and meta_value:
        return header_value + "; " + meta_value
    return header_value or meta_value or ""


def attach_monitor(page):
    monitor = {"dialogs": [], "console": [], "errors": []}

    def on_dialog(dialog):
        monitor["dialogs"].append({
            "type": dialog.type,
            "message": (dialog.message or "")[:300],
        })
        try:
            dialog.dismiss()
        except Exception:
            pass

    def on_console(message):
        if message.type in ("error", "warning"):
            monitor["console"].append({
                "type": message.type,
                "text": (message.text or "")[:300],
            })

    def on_pageerror(error):
        monitor["errors"].append(str(error)[:300])

    page.on("dialog", on_dialog)
    page.on("console", on_console)
    page.on("pageerror", on_pageerror)
    return monitor


def settle(page, args):
    try:
        page.wait_for_load_state(
            "networkidle",
            timeout=min(2000, max(500, args.browser_timeout * 1000)),
        )
    except Exception:
        pass
    page.wait_for_timeout(max(0, args.settle_ms))


def mutate_query(page_url: str, name: str, payload: str) -> str:
    parsed = urlparse(page_url)
    pairs = parse_qsl(parsed.query, keep_blank_values=True)
    replaced = False
    out = []
    for key, value in pairs:
        if key == name:
            out.append((key, payload))
            replaced = True
        else:
            out.append((key, value))
    if not replaced:
        out.append((name, payload))
    return urlunparse((
        parsed.scheme, parsed.netloc, parsed.path or "/", parsed.params,
        urlencode(out), parsed.fragment,
    ))


def mutate_hash(page_url: str, name: str, payload: str) -> str:
    parsed = urlparse(page_url)
    if name == "raw":
        fragment = payload
    elif name:
        current = parsed.fragment
        if current.startswith("#"):
            current = current[1:]
        if name in ("h", "q", "query", "search", "url", "redirect", "next", "path"):
            fragment = f"{name}={quote(payload, safe='')}"
        else:
            fragment = f"{name}={quote(payload, safe='')}"
    else:
        fragment = quote(payload, safe='')
    return urlunparse((
        parsed.scheme, parsed.netloc, parsed.path or "/", parsed.params,
        parsed.query, fragment,
    ))


def mutate_path(page_url: str, index: int, payload: str) -> str:
    parsed = urlparse(page_url)
    segments = parsed.path.split("/")
    if not segments:
        segments = ["", ""]
    if index < 0 or index >= len(segments):
        segments.append(quote(payload, safe=""))
    else:
        segments[index] = quote(payload, safe="")
    return urlunparse((
        parsed.scheme, parsed.netloc, "/".join(segments), parsed.params,
        parsed.query, parsed.fragment,
    ))


def param_names_from_findings(findings):
    names = set()
    for finding in findings or []:
        text = (finding.get("snippet") or "") + " " + (finding.get("match") or "")
        for match in re.finditer(
            r"""(?:searchParams|params|query|URLSearchParams)"""
            r"""[^;\n]{0,120}?\.get\(\s*['"]([^'"]+)['"]""",
            text,
            re.I,
        ):
            names.add(match.group(1))
    return names


def discover_inputs(page, page_url, known_params, findings, args):
    cases = []
    parsed = urlparse(page_url)
    seen = set()

    def add(kind, name, **extra):
        key = (kind, name, extra.get("form_index"), extra.get("field_index"))
        if key in seen:
            return
        seen.add(key)
        cases.append(InputCase(
            page_url=page_url,
            kind=kind,
            name=name,
            method=extra.get("method", "GET"),
            action=extra.get("action", ""),
            form_index=extra.get("form_index", -1),
            field_index=extra.get("field_index", -1),
            field_type=extra.get("field_type", ""),
            extra={k: v for k, v in extra.items() if k not in (
                "method", "action", "form_index", "field_index", "field_type",
            )},
        ))

    query_pairs = parse_qsl(parsed.query, keep_blank_values=True)
    for name, _ in query_pairs:
        add("query", name)
    for name in sorted(known_params):
        if name not in {key for key, _ in query_pairs}:
            add("query", name)
    if args.fuzz_params:
        for name in COMMON_QUERY_NAMES:
            if name not in {key for key, _ in query_pairs}:
                add("query", name)

    fragment = parsed.fragment
    if fragment:
        add("hash", "raw")
        fragment_query = fragment.split("?", 1)[1] if "?" in fragment else fragment
        for name, _ in parse_qsl(fragment_query, keep_blank_values=True):
            add("hash", name)
        for name in COMMON_HASH_NAMES:
            add("hash", name)
    else:
        add("hash", "raw")
        for name in COMMON_HASH_NAMES:
            add("hash", name)

    if args.test_path:
        path_segments = parsed.path.split("/")
        for index, segment in enumerate(path_segments):
            if not segment:
                continue
            if "." in segment and segment.rsplit(".", 1)[-1].lower() in (
                "js", "mjs", "css", "png", "jpg", "jpeg", "gif", "svg",
                "webp", "ico", "woff", "woff2", "ttf", "map",
            ):
                continue
            add("path", str(index), index=index, segment=segment)
        if not any(segment for segment in path_segments):
            add("path", "root", index=1, segment="")

    if args.postmessage:
        add("postmessage", "message")

    if args.storage:
        try:
            storage = page.evaluate("""() => ({
              local: Object.keys(localStorage),
              session: Object.keys(sessionStorage)
            })""")
        except Exception:
            storage = {}
        for store_name, store_key in (("local", "localStorage"), ("session", "sessionStorage")):
            for key in (storage or {}).get(store_name, []):
                if any(s in key.lower() for s in SENSITIVE_KEYS) and not args.storage_keys:
                    continue
                if args.storage_keys and key not in args.storage_keys:
                    continue
                add("storage", f"{store_name}:{key}", store=store_key, key=key)

    if args.window_name:
        add("window_name", "window.name")
    if args.referrer:
        add("referrer", "document.referrer")

    if args.forms:
        try:
            forms = page.evaluate("""() => Array.from(document.forms).map((form, formIndex) => ({
              action: form.action || location.href,
              method: (form.method || 'get').toLowerCase(),
              fields: Array.from(form.elements).map((element, fieldIndex) => ({
                index: fieldIndex,
                name: element.name || '',
                type: String(element.type || element.tagName || '').toLowerCase(),
                tag: String(element.tagName || '').toLowerCase()
              }))
            }))""")
        except Exception:
            forms = []
        for form_index, form in enumerate(forms or []):
            method = str(form.get("method") or "get").lower()
            if method == "post" and not args.allow_post:
                continue
            action = form.get("action") or page_url
            if not same_origin(action, page_url):
                continue
            if any(re.search(rx, action) for rx in args.exclude_url):
                continue
            for field in form.get("fields") or []:
                name = str(field.get("name") or "")
                field_type = str(field.get("type") or "").lower()
                if not name:
                    continue
                if field_type in (
                    "submit", "button", "reset", "file", "image", "password",
                    "hidden", "checkbox", "radio",
                ):
                    continue
                if any(s in name.lower() for s in SENSITIVE_KEYS):
                    continue
                add(
                    "form", name,
                    method=method.upper(),
                    action=action,
                    form_index=form_index,
                    field_index=int(field.get("index") or 0),
                    field_type=field_type,
                )

    if args.cookies:
        try:
            cookie_names = page.evaluate("""() => document.cookie
              .split(';')
              .map(item => item.trim().split('=')[0])
              .filter(Boolean)""")
        except Exception:
            cookie_names = []
        for name in cookie_names or []:
            if any(s in name.lower() for s in SENSITIVE_KEYS):
                continue
            add("cookie", name)

    caps = {
        "query": 20, "hash": 10, "path": 5, "form": 10, "storage": 10,
        "cookie": 5, "postmessage": 1, "window_name": 1, "referrer": 1,
    }
    selected, used = [], {}
    for case in cases:
        limit = caps.get(case.kind, 10)
        if used.get(case.kind, 0) >= limit:
            continue
        used[case.kind] = used.get(case.kind, 0) + 1
        selected.append(case)
    for required in ("postmessage", "storage", "window_name", "referrer"):
        if any(case.kind == required for case in selected):
            continue
        match = next((case for case in cases if case.kind == required), None)
        if match is not None:
            selected.insert(0, match)
    return selected[: args.max_inputs_per_page]


def fill_form(page, case: InputCase, payload: str):
    page.evaluate("""([formIndex, fieldIndex, value]) => {
      const form = document.forms[formIndex];
      if (!form) return;
      const element = form.elements[fieldIndex];
      if (!element) return;
      element.focus();
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }""", [case.form_index, case.field_index, payload])


def submit_form(page, case: InputCase):
    page.evaluate("""(formIndex) => {
      const form = document.forms[formIndex];
      if (!form) return;
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.submit();
      }
    }""", case.form_index)


def send_postmessage(page, payload: str):
    page.evaluate("""(payload) => {
      const shapes = [
        payload,
        { data: payload },
        { html: payload },
        { message: payload },
        { content: payload },
        { type: 'xss', data: payload }
      ];
      for (const shape of shapes) {
        try { window.postMessage(shape, '*'); } catch (e) {}
        const eventInit = {
          data: shape,
          origin: location.origin,
          source: window
        };
        try { window.dispatchEvent(new MessageEvent('message', eventInit)); } catch (e) {}
        try { document.dispatchEvent(new MessageEvent('message', eventInit)); } catch (e) {}
        try { self.dispatchEvent(new MessageEvent('message', eventInit)); } catch (e) {}
      }
    }""", payload)


def set_storage(page, case: InputCase, payload: str):
    store = case.extra.get("store", "localStorage")
    key = case.extra.get("key", case.name.split(":", 1)[-1])
    page.evaluate("""([storeName, key, value]) => {
      const store = window[storeName];
      if (!store) return;
      store.setItem(key, value);
    }""", [store, key, payload])


def get_storage(page, case: InputCase):
    store = case.extra.get("store", "localStorage")
    key = case.extra.get("key", case.name.split(":", 1)[-1])
    try:
        return page.evaluate("""([storeName, key]) => window[storeName]
          ? window[storeName].getItem(key) : null""", [store, key])
    except Exception:
        return None


def restore_storage(page, case: InputCase, original):
    store = case.extra.get("store", "localStorage")
    key = case.extra.get("key", case.name.split(":", 1)[-1])
    try:
        page.evaluate("""([storeName, key, value]) => {
          const store = window[storeName];
          if (!store) return;
          if (value === null || value === undefined) store.removeItem(key);
          else store.setItem(key, value);
        }""", [store, key, original])
    except Exception:
        pass


def click_javascript_links(page):
    try:
        page.evaluate("""() => {
          const links = Array.from(document.querySelectorAll(
            'a[href], area[href]'
          ));
          for (const link of links) {
            const href = String(link.getAttribute('href') || '').trim();
            if (!/^javascript:/i.test(href)) continue;
            try { link.click(); } catch (e) {}
          }
        }""")
        page.wait_for_timeout(400)
    except Exception:
        pass


def collect_hits(page, context):
    hits = []
    seen = set()
    pages = [page]
    for candidate in context.pages:
        if candidate is not page:
            pages.append(candidate)
    for candidate in pages:
        try:
            state = candidate.evaluate("() => window.__domxss || null")
        except Exception:
            state = None
        if state:
            for hit in state.get("hits") or []:
                key = (hit.get("kind"), hit.get("detail"), hit.get("url"))
                if key not in seen:
                    seen.add(key)
                    hits.append(hit)
        try:
            frames = candidate.frames
        except Exception:
            frames = []
        for frame in frames:
            try:
                frame_state = frame.evaluate("() => window.__domxss || null")
            except Exception:
                frame_state = None
            if not frame_state:
                continue
            for hit in frame_state.get("hits") or []:
                key = (hit.get("kind"), hit.get("detail"), hit.get("url"))
                if key not in seen:
                    seen.add(key)
                    hits.append(hit)
    return hits


def collect_csp(page, context):
    events = []
    seen = set()
    for candidate in [page] + [p for p in context.pages if p is not page]:
        try:
            state = candidate.evaluate("() => window.__domxss || null")
        except Exception:
            state = None
        if state:
            for event in state.get("csp") or []:
                key = (event.get("directive"), event.get("blockedURI"), event.get("sample"))
                if key not in seen:
                    seen.add(key)
                    events.append(event)
    return events


def check_reflection(page, payload: str) -> bool:
    needles = [payload, quote(payload, safe=""), MARK]
    try:
        content = page.content()
    except Exception:
        content = ""
    try:
        text = page.evaluate("() => document.body ? document.body.innerText : ''")
    except Exception:
        text = ""
    return any(needle and (needle in content or needle in text) for needle in needles)


def screenshot(page, args, result):
    if not args.screenshot_dir or result.status != "CONFIRMED_EXECUTION":
        return ""
    try:
        os.makedirs(args.screenshot_dir, exist_ok=True)
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", result.payload_id)
        path = os.path.join(
            args.screenshot_dir,
            f"confirmed_{safe}_{int(time.time() * 1000)}.png",
        )
        page.screenshot(path=path, full_page=True)
        return path
    except Exception:
        return ""


@dataclass
class InputCase:
    page_url: str
    kind: str
    name: str
    method: str = "GET"
    action: str = ""
    form_index: int = -1
    field_index: int = -1
    field_type: str = ""
    extra: dict = field(default_factory=dict)


@dataclass
class TestResult:
    page_url: str
    input_kind: str
    input_name: str
    payload_id: str
    payload_context: str
    payload: str
    target: str
    status: str = "INCONCLUSIVE"
    hits: list = field(default_factory=list)
    csp_blocked: bool = False
    csp_events: list = field(default_factory=list)
    reflected: bool = False
    console: list = field(default_factory=list)
    errors: list = field(default_factory=list)
    screenshot: str = ""
    error: str = ""


def run_case(context, case: InputCase, payload: dict, args):
    page = context.new_page()
    monitor = attach_monitor(page)
    result = TestResult(
        page_url=case.page_url,
        input_kind=case.kind,
        input_name=case.name,
        payload_id=payload["id"],
        payload_context=payload["context"],
        payload=payload["value"],
        target=redact_url(case.page_url),
    )
    original_cookie = None
    original_storage = None
    try:
        page.set_default_timeout(max(1000, args.browser_timeout * 1000))
        csp_text = ""
        response = None

        if case.kind == "query":
            target = mutate_query(case.page_url, case.name, payload["value"])
            result.target = redact_url(target)
            response = page.goto(target, wait_until="domcontentloaded")
        elif case.kind == "hash":
            target = mutate_hash(case.page_url, case.name, payload["value"])
            result.target = redact_url(target)
            response = page.goto(target, wait_until="domcontentloaded")
            try:
                fragment = target.split("#", 1)[1] if "#" in target else ""
                page.evaluate("value => { location.hash = value; }", fragment)
            except Exception:
                pass
        elif case.kind == "path":
            target = mutate_path(
                case.page_url,
                int(case.extra.get("index", 0)),
                payload["value"],
            )
            result.target = redact_url(target)
            response = page.goto(target, wait_until="domcontentloaded")
        elif case.kind == "form":
            response = page.goto(case.page_url, wait_until="domcontentloaded")
            settle(page, args)
            fill_form(page, case, payload["value"])
            submit_form(page, case)
            try:
                page.wait_for_load_state("networkidle", timeout=2000)
            except Exception:
                pass
        elif case.kind == "postmessage":
            response = page.goto(case.page_url, wait_until="domcontentloaded")
            settle(page, args)
            send_postmessage(page, payload["value"])
        elif case.kind == "storage":
            response = page.goto(case.page_url, wait_until="domcontentloaded")
            settle(page, args)
            original_storage = get_storage(page, case)
            set_storage(page, case, payload["value"])
            response = page.reload(wait_until="domcontentloaded")
        elif case.kind == "window_name":
            response = page.goto(case.page_url, wait_until="domcontentloaded")
            settle(page, args)
            page.evaluate("value => { window.name = value; }", payload["value"])
            response = page.reload(wait_until="domcontentloaded")
        elif case.kind == "referrer":
            separator = "&" if "?" in case.page_url else "?"
            referer = (
                case.page_url + separator + "ref=" + quote(payload["value"], safe="")
            )
            result.target = redact_url(case.page_url)
            response = page.goto(case.page_url, referer=referer, wait_until="domcontentloaded")
        elif case.kind == "cookie":
            try:
                cookie_pairs = context.cookies([case.page_url])
            except Exception:
                cookie_pairs = []
            for cookie in cookie_pairs:
                if cookie.get("name") == case.name:
                    original_cookie = cookie
                    break
            context.add_cookies([{
                "name": case.name,
                "value": quote(payload["value"], safe=""),
                "url": case.page_url,
            }])
            response = page.goto(case.page_url, wait_until="domcontentloaded")
        else:
            raise ValueError(f"Unknown input kind: {case.kind}")

        settle(page, args)
        if origin(page.url) != origin(case.page_url):
            result.status = "INCONCLUSIVE"
            result.error = f"Redirected off-origin to {page.url}"
            return result
        click_javascript_links(page)
        settle(page, args)

        csp_text = get_csp(page, response)
        csp = parse_csp(csp_text)
        result.csp_events = collect_csp(page, context)
        for message in monitor["console"]:
            if "Content Security Policy" in message.get("text", ""):
                result.csp_events.append({
                    "directive": "",
                    "blockedURI": "",
                    "sample": message.get("text", "")[:300],
                })
        if payload["context"] == "code":
            payload_blocked = csp["blocks_eval"]
        elif payload["context"] == "url":
            payload_blocked = csp["blocks_inline"]
        elif "srcdoc" in payload["value"]:
            payload_blocked = csp["blocks_frames"] or csp["blocks_inline"]
        else:
            payload_blocked = csp["blocks_inline"]
        result.csp_blocked = bool(payload_blocked and csp["raw"])

        result.hits = collect_hits(page, context)
        result.reflected = check_reflection(page, payload["value"])
        result.console = monitor["console"][:10]
        result.errors = monitor["errors"][:10]

        if result.hits:
            result.status = "CONFIRMED_EXECUTION"
        elif result.reflected and (result.csp_events or result.csp_blocked):
            result.status = "INJECTED_BLOCKED_BY_CSP"
        elif result.reflected:
            result.status = "INJECTED_NOT_EXECUTED"
        elif result.csp_events:
            result.status = "BLOCKED_BY_CSP"
        else:
            result.status = "NOT_REFLECTED"

        result.screenshot = screenshot(page, args, result)
        for other in list(context.pages):
            if other is not page:
                try:
                    other.close()
                except Exception:
                    pass
    except Exception as exc:
        result.status = "INCONCLUSIVE"
        result.error = f"{type(exc).__name__}: {exc}"[:500]
    finally:
        try:
            if case.kind == "storage":
                restore_storage(page, case, original_storage)
            if case.kind == "window_name":
                page.evaluate("() => { window.name = ''; }")
            if case.kind == "cookie":
                try:
                    context.clear_cookies(name=case.name)
                except Exception:
                    pass
                if original_cookie:
                    keep = {
                        key: original_cookie[key] for key in (
                            "name", "value", "domain", "path", "expires",
                            "httpOnly", "secure", "sameSite",
                        ) if key in original_cookie
                    }
                    try:
                        context.add_cookies([keep])
                    except Exception:
                        pass
        except Exception:
            pass
        try:
            page.close()
        except Exception:
            pass
    return result


def dynamic_probe(args, static_findings, static_param_names=None):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "Dynamic mode requires Playwright. Install with:\n"
            "  python3 -m pip install playwright\n"
            "  python3 -m playwright install chromium"
        ) from exc

    headers = parse_headers(args.header)
    if args.auth_token:
        headers.setdefault("Authorization", f"Bearer {args.auth_token}")
    payloads = build_payloads(args)
    known_params = param_names_from_findings(static_findings)
    known_params.update(static_param_names or [])
    start = normalize(args.url, keep_query=True, keep_hash=True)
    start_origin = origin(start)
    if start_origin is None:
        raise RuntimeError(f"Invalid starting URL: {args.url}")

    inputs, tests = [], []
    csp_pages = {}
    warnings = []
    dry_run = bool(args.dry_run)

    with sync_playwright() as playwright:
        browser_type = getattr(playwright, args.browser)
        launch_kwargs = {"headless": not args.headed}
        if args.proxy:
            launch_kwargs["proxy"] = {"server": args.proxy}
        browser = browser_type.launch(**launch_kwargs)

        context_kwargs = {
            "ignore_https_errors": args.insecure,
            "extra_http_headers": headers,
            "service_workers": "block" if args.block_service_workers else "allow",
        }
        if args.storage_state:
            context_kwargs["storage_state"] = args.storage_state
        if args.user_agent:
            context_kwargs["user_agent"] = args.user_agent
        context = browser.new_context(**context_kwargs)
        context.add_init_script(build_init_script(args))
        if args.trace:
            context.tracing.start(screenshots=True, snapshots=True, sources=False)

        if args.cookie:
            cookie_url = normalize(start, keep_query=False, keep_hash=False)
            cookies = []
            for raw in args.cookie:
                for name, value in parse_cookie(raw).items():
                    cookies.append({
                        "name": name,
                        "value": value,
                        "url": cookie_url,
                    })
            if cookies:
                context.add_cookies(cookies)

        queue = [start]
        seen = set()
        while queue and len(seen) < args.dynamic_max_pages:
            page_url = normalize(queue.pop(0), keep_query=True, keep_hash=True)
            if page_url in seen or origin(page_url) != start_origin:
                continue
            seen.add(page_url)
            page = context.new_page()
            monitor = attach_monitor(page)
            try:
                response = page.goto(
                    page_url,
                    wait_until="domcontentloaded",
                    timeout=max(1000, args.browser_timeout * 1000),
                )
                settle(page, args)
                final_url = page.url
                if origin(final_url) != start_origin:
                    warnings.append(
                        f"Dynamic crawl redirected off-origin: {redact_url(page_url)}"
                    )
                    continue
                csp_pages[final_url] = parse_csp(get_csp(page, response))
                if not args.quiet:
                    print(f"[DYNAMIC PAGE] {final_url}")
                page_inputs = discover_inputs(
                    page, final_url, known_params, static_findings, args
                )
                inputs.extend(page_inputs)
                hrefs = page.eval_on_selector_all(
                    "a[href]",
                    "elements => elements.map(element => element.href)",
                )
                for href in hrefs:
                    if not href:
                        continue
                    candidate = normalize(href, keep_query=True, keep_hash=True)
                    if any(re.search(rx, candidate) for rx in args.exclude_url):
                        continue
                    if origin(candidate) != start_origin:
                        continue
                    if urlparse(candidate).scheme.lower() not in ("http", "https"):
                        continue
                    if candidate not in seen and candidate not in queue:
                        if len(seen) + len(queue) < args.dynamic_max_pages * 4:
                            queue.append(candidate)
            except Exception as exc:
                warnings.append(
                    f"Dynamic crawl failed for {redact_url(page_url)}: {exc}"
                )
            finally:
                try:
                    page.close()
                except Exception:
                    pass

        deduped, seen_inputs = [], set()
        for case in inputs:
            key = (case.kind, case.name, case.page_url, case.form_index, case.field_index)
            if key not in seen_inputs:
                seen_inputs.add(key)
                deduped.append(case)
        priority = {
            "query": 0, "hash": 1, "path": 2, "postmessage": 3,
            "storage": 4, "window_name": 5, "referrer": 6,
            "form": 7, "cookie": 8,
        }
        buckets = {}
        for case in deduped:
            buckets.setdefault(case.kind, []).append(case)
        order = [
            "query", "hash", "path", "postmessage", "storage",
            "window_name", "referrer", "form", "cookie",
        ]
        inputs = []
        for index in range(max((len(bucket) for bucket in buckets.values()), default=0)):
            for kind in order:
                bucket = buckets.get(kind) or []
                if index < len(bucket):
                    inputs.append(bucket[index])

        if not args.quiet:
            print(
                f"[DYNAMIC] discovered {len(inputs)} inputs, "
                f"{len(payloads)} payloads, limit {args.dynamic_max_tests} tests"
            )

        for case in inputs:
            confirmed_for_case = False
            for payload in payloads:
                if len(tests) >= args.dynamic_max_tests:
                    break
                if confirmed_for_case:
                    break
                if dry_run:
                    tests.append(TestResult(
                        page_url=case.page_url,
                        input_kind=case.kind,
                        input_name=case.name,
                        payload_id=payload["id"],
                        payload_context=payload["context"],
                        payload=payload["value"],
                        target="",
                        status="DRY_RUN",
                    ))
                    continue
                result = run_case(context, case, payload, args)
                tests.append(result)
                if result.status == "CONFIRMED_EXECUTION":
                    confirmed_for_case = True
                    if not args.quiet:
                        print(
                            f"[CONFIRMED] {case.kind}:{case.name} "
                            f"payload={payload['id']} page={redact_url(case.page_url)}"
                        )
                elif result.status == "INJECTED_BLOCKED_BY_CSP":
                    if not args.quiet:
                        print(
                            f"[CSP-BLOCKED] {case.kind}:{case.name} "
                            f"payload={payload['id']} page={redact_url(case.page_url)}"
                        )
                if args.delay:
                    time.sleep(max(0.0, args.delay))
            if len(tests) >= args.dynamic_max_tests:
                break

        if args.trace:
            try:
                context.tracing.stop(path=args.trace)
            except Exception as exc:
                warnings.append(f"Unable to write Playwright trace: {exc}")
        context.close()
        browser.close()

    confirmed = [test for test in tests if test.status == "CONFIRMED_EXECUTION"]
    blocked = [test for test in tests if test.status == "INJECTED_BLOCKED_BY_CSP"]
    injected = [test for test in tests if test.status == "INJECTED_NOT_EXECUTED"]
    not_reflected = [test for test in tests if test.status == "NOT_REFLECTED"]
    inconclusive = [test for test in tests if test.status == "INCONCLUSIVE"]

    if dry_run:
        status = "dry_run"
    elif not tests:
        status = "no_tests"
    else:
        status = "completed"

    return {
        "status": status,
        "method": (
            "Playwright; authenticated-context crawl; query, hash, path, "
            "form, postMessage, storage, window.name, referrer, cookie "
            "canaries with execution markers"
        ),
        "coverage": {
            "pages_crawled": len(seen),
            "inputs_discovered": len(inputs),
            "tests_run": len(tests),
            "test_limit": args.dynamic_max_tests,
            "payloads": [item["id"] for item in payloads],
            "confirmed": len(confirmed),
            "blocked_by_csp": len(blocked),
            "injected_not_executed": len(injected),
            "not_reflected": len(not_reflected),
            "inconclusive": len(inconclusive),
            "inputs_by_kind": dict(Counter(case.kind for case in inputs)),
        },
        "csp": {
            redact_url(url): info for url, info in csp_pages.items()
        },
        "inputs": [redacted_input(case) for case in inputs],
        "tests": [redacted_test(test) for test in tests],
        "confirmed": [redacted_test(test) for test in confirmed],
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Reporting and CLI
# ---------------------------------------------------------------------------


def safe_command(argv):
    sensitive = {"--auth-token", "--cookie", "--header", "--storage-state"}
    out, skip = [], False
    for arg in argv:
        if skip:
            skip = False
            continue
        if arg in sensitive:
            out.extend([arg, "[redacted]"])
            skip = True
        elif any(arg.startswith(item + "=") for item in sensitive):
            out.append(arg.split("=", 1)[0] + "=[redacted]")
        else:
            out.append(arg)
    return " ".join(out)


def redacted_input(case):
    value = asdict(case)
    value["page_url"] = redact_url(value.get("page_url") or "")
    if value.get("action"):
        value["action"] = redact_url(value["action"])
    return value


def redacted_test(test):
    value = asdict(test)
    value["page_url"] = redact_url(value.get("page_url") or "")
    if value.get("target"):
        value["target"] = redact_url(value["target"])
    return value


def count_by(items, key):
    return dict(Counter(item.get(key) for item in items or []))


def print_findings(title, findings, limit=40):
    print(f"\n=== {title} ===")
    if not findings:
        print("No findings.")
        return
    for index, finding in enumerate(findings[:limit], 1):
        print(
            f"{index}. [{finding['severity'].upper()} | {finding['confidence']}] "
            f"{finding['rule']} at {redact_url(finding['url'])}:{finding['line']}"
        )
        print(f"   {finding['snippet'][:500]}")
        if finding.get("flow"):
            print(f"   flow: {finding['flow']}")
        print(f"   {finding['advice']}")
    if len(findings) > limit:
        print(f"Only first {limit} shown. Full list is in the JSON report.")


def print_dynamic(result):
    if not result:
        return
    print("\n=== DYNAMIC ===")
    print(f"Status: {result.get('status')}")
    coverage = result.get("coverage") or {}
    if coverage:
        print(
            "Pages: {pages_crawled} | Inputs: {inputs_discovered} | "
            "Tests: {tests_run} | Confirmed: {confirmed} | "
            "CSP-blocked: {blocked_by_csp} | Injected: {injected_not_executed} | "
            "Not reflected: {not_reflected} | Inconclusive: {inconclusive}".format(
                **{
                    key: coverage.get(key, 0) for key in (
                        "pages_crawled", "inputs_discovered", "tests_run",
                        "confirmed", "blocked_by_csp", "injected_not_executed",
                        "not_reflected", "inconclusive",
                    )
                }
            )
        )
        by_kind = coverage.get("inputs_by_kind") or {}
        if by_kind:
            print("Inputs by kind: " + ", ".join(
                f"{key}={value}" for key, value in sorted(by_kind.items())
            ))
    for test in result.get("confirmed") or []:
        print(
            f"\n[CONFIRMED] {test['input_kind']}:{test['input_name']} "
            f"payload={test['payload_id']} ({test['payload_context']})"
        )
        print(f"   page: {redact_url(test['page_url'])}")
        if test.get("target"):
            print(f"   target: {test['target']}")
        for hit in (test.get("hits") or [])[:5]:
            print(f"   marker: {hit.get('kind')} via {hit.get('url')}")
        if test.get("screenshot"):
            print(f"   screenshot: {test['screenshot']}")
    blocked = [
        test for test in (result.get("tests") or [])
        if test.get("status") == "INJECTED_BLOCKED_BY_CSP"
    ]
    if blocked:
        print(f"\n[CSP-BLOCKED] {len(blocked)} injections were parsed but blocked by CSP.")
        for test in blocked[:10]:
            print(
                f"   {test['input_kind']}:{test['input_name']} "
                f"payload={test['payload_id']} page={redact_url(test['page_url'])}"
            )
    csp_pages = result.get("csp") or {}
    if csp_pages:
        print("\nCSP notes:")
        for page_url, info in list(csp_pages.items())[:10]:
            if not info.get("raw"):
                print(f"   {redact_url(page_url)}: no CSP")
            else:
                print(
                    f"   {redact_url(page_url)}: script-src="
                    f"{' '.join(info.get('script_src') or []) or '(default)'} "
                    f"inline_blocked={info.get('blocks_inline')} "
                    f"eval_blocked={info.get('blocks_eval')}"
                )
    if result.get("error"):
        print("Error: " + str(result["error"]))
    for warning in result.get("warnings") or []:
        print("Warning: " + warning)


def sanitized_args(args):
    out = {}
    for key, value in vars(args).items():
        if key in ("auth_token", "header", "cookie"):
            continue
        if isinstance(value, Path):
            value = str(value)
        if key == "url" and value:
            value = redact_url(value)
        out[key] = value
    return out


def write_json_report(path, report):
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, ensure_ascii=False)
    try:
        os.chmod(target, 0o600)
    except OSError:
        pass
    return str(target)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="dom_xss_review.py",
        description=(
            "DOM XSS review: static source/sink analysis, local source scan, "
            "and a Playwright exploitation suite for URL, form, storage, "
            "postMessage, referrer, cookie, and code-sink vectors."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  dom_xss_review.py https://example.test --json report.json\n"
            "  dom_xss_review.py https://example.test --dynamic --max-pages 25\n"
            "  dom_xss_review.py --source ./src --source ./site --json source.json\n"
            "  dom_xss_review.py https://example.test --dynamic --auth-token \"$TOKEN\"\n"
        ),
    )
    parser.add_argument("url", nargs="?", help="Starting URL, including scheme")
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")

    crawl = parser.add_argument_group("static crawl")
    crawl.add_argument("--max-pages", type=int, default=25)
    crawl.add_argument("--max-assets", type=int, default=200)
    crawl.add_argument("--max-bytes", type=int, default=3_000_000)
    crawl.add_argument("--timeout", type=int, default=15)
    crawl.add_argument("--delay", type=float, default=0.15)
    crawl.add_argument("--include-query-links", action="store_true")
    crawl.add_argument("--include-hash", action="store_true", default=True)
    crawl.add_argument("--no-include-hash", dest="include_hash", action="store_false")
    crawl.add_argument("--cacert", help="CA bundle for HTTPS verification")
    crawl.add_argument("--insecure", action="store_true",
                       help="Disable TLS verification. Authorized testing only.")
    crawl.add_argument("--user-agent", default=USER_AGENT)
    crawl.add_argument("--header", action="append", default=[],
                       help="Extra request header, repeatable: 'Name: value'")
    crawl.add_argument("--cookie", action="append", default=[],
                       help="Cookie, repeatable: 'name=value'")
    crawl.add_argument("--exclude-url", action="append", default=["/cdn-cgi/"],
                       help="Regex of URLs to skip, repeatable (default: /cdn-cgi/)")

    source = parser.add_argument_group("source scan")
    source.add_argument("--source", action="append", default=[],
                        help="Local file or directory to scan, repeatable")
    source.add_argument(
        "--source-exclude",
        default="node_modules,dist,build,coverage,.git,.next,.output,releases",
        help="Comma-separated directory names to skip",
    )

    dynamic = parser.add_argument_group("dynamic testing")
    dynamic.add_argument("--dynamic", action="store_true",
                         help="Run browser-based exploitation tests")
    dynamic.add_argument("--dry-run", action="store_true",
                         help="Discover inputs and list tests without sending payloads")
    dynamic.add_argument("--browser", choices=("chromium", "firefox", "webkit"),
                         default="chromium")
    dynamic.add_argument("--headed", action="store_true")
    dynamic.add_argument("--proxy", help="Proxy server URL, e.g. http://127.0.0.1:8080")
    dynamic.add_argument("--storage-state", help="Playwright storage state JSON")
    dynamic.add_argument("--auth-token", help="Bearer token for requests and localStorage")
    dynamic.add_argument("--auth-storage-key", default="nebulis_auth_token",
                         help="localStorage key seeded with --auth-token")
    dynamic.add_argument("--trace", help="Write a Playwright trace zip to this path")
    dynamic.add_argument("--screenshot-dir", help="Save screenshots of confirmed tests")
    dynamic.add_argument("--block-service-workers", action="store_true", default=True)
    dynamic.add_argument("--allow-service-workers", dest="block_service_workers",
                         action="store_false")
    dynamic.add_argument("--browser-timeout", type=int, default=20)
    dynamic.add_argument("--settle-ms", type=int, default=900)
    dynamic.add_argument("--dynamic-max-pages", type=int, default=15)
    dynamic.add_argument("--dynamic-max-tests", type=int, default=200)
    dynamic.add_argument("--max-inputs-per-page", type=int, default=40)
    dynamic.add_argument("--payloads", choices=("basic", "full"), default="full")
    dynamic.add_argument("--fail-on", choices=("confirmed", "high", "medium", "low", "none"),
                         default="confirmed")
    dynamic.add_argument("--allow-no-tests", action="store_true",
                         help="Do not treat a dynamic run with zero tests as incomplete")

    inputs = parser.add_argument_group("dynamic inputs")
    inputs.add_argument("--fuzz-params", action="store_true",
                        help="Also try a list of common parameter names")
    inputs.add_argument("--forms", action="store_true", default=True)
    inputs.add_argument("--no-forms", dest="forms", action="store_false")
    inputs.add_argument("--allow-post", action="store_true",
                        help="Submit POST forms. May change server state.")
    inputs.add_argument("--postmessage", action="store_true", default=True)
    inputs.add_argument("--no-postmessage", dest="postmessage", action="store_false")
    inputs.add_argument("--storage", action="store_true", default=True)
    inputs.add_argument("--no-storage", dest="storage", action="store_false")
    inputs.add_argument("--storage-keys", default="",
                        help="Comma-separated storage keys to test")
    inputs.add_argument("--cookies", action="store_true", default=True)
    inputs.add_argument("--no-cookies", dest="cookies", action="store_false")
    inputs.add_argument("--path", dest="test_path", action="store_true", default=True)
    inputs.add_argument("--no-path", dest="test_path", action="store_false")
    inputs.add_argument("--window-name", dest="window_name", action="store_true", default=True)
    inputs.add_argument("--no-window-name", dest="window_name", action="store_false")
    inputs.add_argument("--referrer", dest="referrer", action="store_true", default=True)
    inputs.add_argument("--no-referrer", dest="referrer", action="store_false")

    output = parser.add_argument_group("output")
    output.add_argument("--include-sources", action="store_true",
                        help="Also report source-only matches (noisy)")
    output.add_argument("--json", dest="json_path", help="Write the full JSON report")
    output.add_argument("--quiet", action="store_true")
    return parser


def check_args(parser, args):
    if not args.url and not args.source:
        parser.error("Provide a URL, at least one --source, or both")
    if args.dynamic and not args.url:
        parser.error("--dynamic requires a URL")
    if args.max_pages < 1:
        parser.error("--max-pages must be >= 1")
    if args.max_assets < 0:
        parser.error("--max-assets must be >= 0")
    if args.max_bytes < 1024:
        parser.error("--max-bytes must be >= 1024")
    if args.timeout < 1:
        parser.error("--timeout must be >= 1")
    if args.dynamic_max_pages < 1 or args.dynamic_max_tests < 1:
        parser.error("--dynamic-max-pages and --dynamic-max-tests must be >= 1")
    if args.max_inputs_per_page < 1:
        parser.error("--max-inputs-per-page must be >= 1")
    if args.settle_ms < 0:
        parser.error("--settle-ms must be >= 0")
    if args.browser_timeout < 1:
        parser.error("--browser-timeout must be >= 1")
    if args.storage_state and not Path(args.storage_state).expanduser().exists():
        parser.error(f"--storage-state does not exist: {args.storage_state}")
    if args.trace and not args.dynamic:
        parser.error("--trace requires --dynamic")
    if args.screenshot_dir and not args.dynamic:
        parser.error("--screenshot-dir requires --dynamic")


def fail_threshold(args, static_result, source_result, dynamic_result):
    if args.fail_on == "none":
        return False
    coverage = (dynamic_result or {}).get("coverage") or {}
    if coverage.get("confirmed"):
        return True
    if args.fail_on == "confirmed":
        return False
    findings = []
    if static_result:
        findings.extend(static_result.get("findings") or [])
    if source_result:
        findings.extend(source_result.get("findings") or [])
    sink_findings = [
        finding for finding in findings
        if finding.get("kind") != "source" and finding.get("confidence") != "constant"
    ]
    severities = {finding.get("severity") for finding in sink_findings}
    if args.fail_on == "high":
        return "high" in severities or "critical" in severities
    if args.fail_on == "medium":
        return bool(severities & {"critical", "high", "medium"})
    if args.fail_on == "low":
        return bool(severities & {"critical", "high", "medium", "low"})
    return False


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    check_args(parser, args)
    try:
        headers = parse_headers(args.header)
    except ValueError as exc:
        parser.error(str(exc))
        return 2
    cookie_parts = []
    try:
        for raw in args.cookie or []:
            for name, value in parse_cookie(raw).items():
                cookie_parts.append(f"{name}={value}")
    except ValueError as exc:
        parser.error(str(exc))
        return 2
    cookie_header = "; ".join(cookie_parts)
    args.storage_keys = split_csv(args.storage_keys)

    print(f"DOM XSS Review v{VERSION}")
    if args.url:
        print(f"Target: {redact_url(args.url)}")
    if args.source:
        print(f"Source paths: {', '.join(args.source)}")
    if args.insecure:
        print("WARNING: TLS certificate verification is disabled.")

    static_result = None
    source_result = None
    dynamic_result = None
    warnings = []
    incomplete = False
    static_failed = False

    if args.url:
        try:
            static_result = static_scan(args, headers, cookie_header)
            warnings.extend(static_result.get("warnings") or [])
            print(
                f"\n=== STATIC ===\n"
                f"Pages: {len(static_result['pages'])} | "
                f"JS assets: {len(static_result['assets'])} | "
                f"Findings: {len(static_result['findings'])}"
            )
            if not static_result["pages"]:
                incomplete = True
            else:
                successful = [
                    page for page in static_result["pages"]
                    if page.get("status") and page["status"] < 400 and not page.get("error")
                ]
                if not successful:
                    static_failed = True
                    print("STATIC INCOMPLETE: no page could be fetched successfully.")
            if not args.quiet:
                missing_csp = [
                    page_url for page_url, value in (static_result.get("csp") or {}).items()
                    if not value
                ]
                if missing_csp:
                    print(
                        f"No Content-Security-Policy on {len(missing_csp)} page(s): "
                        + ", ".join(redact_url(item) for item in missing_csp[:8])
                    )
                print_findings("STATIC FINDINGS", static_result["findings"])
        except Exception as exc:
            static_result = {"pages": [], "assets": [], "findings": [], "csp": {}, "warnings": []}
            warnings.append(f"Static scan failed: {type(exc).__name__}: {exc}")
            static_failed = True
            print(f"Static scan failed: {exc}")

    if args.source:
        try:
            source_result = source_scan(args.source, args)
            warnings.extend(source_result.get("warnings") or [])
            print(
                f"\n=== SOURCE ===\n"
                f"Files: {len(source_result['files'])} | "
                f"Findings: {len(source_result['findings'])}"
            )
            if not args.quiet:
                print_findings("SOURCE FINDINGS", source_result["findings"])
        except Exception as exc:
            source_result = {"files": [], "findings": [], "warnings": []}
            warnings.append(f"Source scan failed: {type(exc).__name__}: {exc}")
            incomplete = True
            print(f"Source scan failed: {exc}")

    if args.dynamic:
        try:
            known = (static_result or {}).get("findings") or []
            known_params = (static_result or {}).get("param_names") or []
            dynamic_result = dynamic_probe(args, known, known_params)
            if dynamic_result.get("status") in ("failed", "no_tests"):
                if not (dynamic_result.get("status") == "no_tests" and args.allow_no_tests):
                    incomplete = True
            if dynamic_result.get("status") == "no_tests":
                print("DYNAMIC INCOMPLETE: no testable inputs were discovered.")
            warnings.extend(dynamic_result.get("warnings") or [])
            if not args.quiet:
                print_dynamic(dynamic_result)
        except Exception as exc:
            dynamic_result = {
                "status": "failed",
                "error": f"{type(exc).__name__}: {exc}",
                "coverage": {},
                "tests": [],
                "confirmed": [],
                "warnings": [],
            }
            incomplete = True
            print(f"\n=== DYNAMIC ===\nStatus: failed\nError: {exc}")

    if static_failed and not ((dynamic_result or {}).get("coverage") or {}).get("confirmed"):
        incomplete = True
    if static_failed:
        warnings.append(
            "Static crawl fetched no successful page; only dynamic evidence (if any) is usable."
        )

    static_findings = (static_result or {}).get("findings") or []
    source_findings = (source_result or {}).get("findings") or []
    all_findings = static_findings + source_findings
    coverage = (dynamic_result or {}).get("coverage") or {}

    report = {
        "meta": {
            "tool": "dom_xss_review",
            "version": VERSION,
            "generated_at": now_iso(),
            "python": sys.version.split()[0],
            "command": safe_command(sys.argv),
        },
        "target": redact_url(args.url) if args.url else None,
        "scope": {
            "source_paths": args.source,
            "dynamic": bool(args.dynamic),
            "authenticated": bool(args.auth_token or args.storage_state or args.cookie),
            "headers": redact_headers(headers),
            "insecure_tls": bool(args.insecure),
            "args": sanitized_args(args),
        },
        "summary": {
            "static_findings": len(static_findings),
            "source_findings": len(source_findings),
            "by_severity": count_by(all_findings, "severity"),
            "by_confidence": count_by(all_findings, "confidence"),
            "dynamic_status": (dynamic_result or {}).get("status"),
            "dynamic_confirmed": coverage.get("confirmed", 0),
            "dynamic_blocked_by_csp": coverage.get("blocked_by_csp", 0),
            "dynamic_injected_not_executed": coverage.get("injected_not_executed", 0),
            "dynamic_tests": coverage.get("tests_run", 0),
        },
        "static": static_result,
        "source": source_result,
        "dynamic": dynamic_result,
        "warnings": warnings,
        "scan_complete": not incomplete,
    }

    if args.json_path:
        try:
            saved = write_json_report(args.json_path, report)
            print(f"\nJSON report saved to: {saved}")
        except OSError as exc:
            print(f"Unable to write JSON report: {exc}", file=sys.stderr)
            return 2

    print("\n=== SUMMARY ===")
    print(
        f"Static: {len(static_findings)} findings | "
        f"Source: {len(source_findings)} findings | "
        f"Confirmed: {coverage.get('confirmed', 0)} | "
        f"Injected but blocked: {coverage.get('blocked_by_csp', 0)} | "
        f"Injected not executed: {coverage.get('injected_not_executed', 0)}"
    )
    print(f"Scan complete: {not incomplete}")

    if incomplete:
        print(
            "SCAN INCOMPLETE: a failure or zero-coverage run must not be "
            "read as a clean result."
        )
        return 2

    if fail_threshold(args, static_result, source_result, dynamic_result):
        print(f"FAIL: findings meet --fail-on {args.fail_on}.")
        return 1

    if (dynamic_result or {}).get("status") == "no_tests":
        print("No dynamic tests were possible; only the static results above apply.")

    print(
        "Interpretation: CONFIRMED_EXECUTION is evidence for the tested "
        "input and payload. INJECTED_BLOCKED_BY_CSP means the injection was "
        "parsed but CSP blocked it. NOT_REFLECTED only covers this test."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
