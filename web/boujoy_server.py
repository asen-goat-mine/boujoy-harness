#!/usr/bin/env python3
"""Local-only product gateway for Boujoy Harness.

The browser UI is deliberately independent from the upstream Harness and Vault UIs.
Only their local APIs are reused. No credentials or knowledge data are persisted here.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import hmac
import ipaddress
import json
import mimetypes
import os
import re
import signal
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
import email.utils
import html as html_lib
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


LOOPBACK = "127.0.0.1"
KB_ORIGIN = "http://127.0.0.1:8765"
HARNESS_ORIGINS = {
    "knowledge": "http://127.0.0.1:3080",
    "clean": "http://127.0.0.1:3081",
}
# CORS allow-list: only loopback product surfaces may call this gateway's APIs.
# Any other Origin (e.g. an arbitrary website open in the browser) must not be
# able to read the vault or drive write endpoints. "null" covers file:// pages.
ALLOWED_ORIGINS = {
    "http://127.0.0.1:8766",
    "http://localhost:8766",
    "http://127.0.0.1:3080",
    "http://localhost:3080",
    "http://127.0.0.1:3081",
    "http://localhost:3081",
    "null",
}

def _origin_allowed(origin: str) -> bool:
    return origin in ALLOWED_ORIGINS
LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
IGNORED_DIRS = {
    ".cache", ".codebuddy", ".codex", ".git", ".agents", ".mypy_cache",
    ".nox", ".openai", ".pytest_cache", ".ruff_cache", ".tox", ".venv",
    ".workbuddy", "__pypackages__", "node_modules", "site-packages", "venv",
    "__pycache__", "99-Logs", "_dist", "dist",
}
PROTECTED_MARKDOWN_ROOTS = ("00-system/", "01-inbox/", "ai-second-brain-ui/", "98-skills/", "99-logs/")
PROTECTED_MARKDOWN_FILES = {"agents.md", "dashboard.md", "readme.md"}


def compact_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def yaml_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'


def safe_slug(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]+", "-", value.strip().lower()).strip("-")
    return cleaned or datetime.now().strftime("record-%Y%m%d%H%M%S")


# -- Minimal WebSocket forwarding --------------------------------------------
# Harness's event streams (events.mux / events.host) are WebSocket-only and
# reject cross-origin upgrades. The product page lives on this gateway (8766)
# while the streams live on the Harness origin (3080/3081). We terminate the
# browser's upgrade here (same-origin, so no Origin problem) and forward frames
# to Harness as a plain TCP client whose upgrade carries no Origin header.

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _ws_accept_key(key: str) -> str:
    digest = hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _ws_handshake(upstream: socket.socket, path: str, host: str) -> bytes | None:
    """Upgrade to Harness as a client and return bytes after the HTTP header.

    A server may coalesce its first WebSocket frame with the HTTP 101 response.
    The caller must relay that trailing payload to the browser before it starts
    the normal byte pump; otherwise an initial ``session/subscribed`` frame can
    be silently lost.
    """
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Sec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode('ascii')}\r\n"
        "\r\n"
    )
    upstream.sendall(request.encode("ascii"))
    response = b""
    while b"\r\n\r\n" not in response:
        chunk = upstream.recv(4096)
        if not chunk:
            return None
        response += chunk
        if len(response) > 16384:
            return None
    header, _, trailing = response.partition(b"\r\n\r\n")
    if b" 101 " not in header.split(b"\r\n", 1)[0]:
        return None
    return trailing


def _ws_relay(browser: socket.socket, upstream: socket.socket) -> None:
    """Bidirectional WebSocket byte relay.

    This gateway only bridges origins; it is not a WebSocket endpoint for the
    upstream Harness. Browser-to-server frames are masked, server-to-browser
    frames are not, and large messages can use continuation frames, so every
    raw byte must cross unchanged.
    """
    stop = threading.Event()

    def pump(source: socket.socket, dest: socket.socket) -> None:
        try:
            while not stop.is_set():
                payload = source.recv(64 * 1024)
                if not payload:
                    break
                dest.sendall(payload)
        except (OSError, ConnectionError):
            pass
        finally:
            stop.set()

    t1 = threading.Thread(target=pump, args=(browser, upstream), daemon=True)
    t2 = threading.Thread(target=pump, args=(upstream, browser), daemon=True)
    t1.start()
    t2.start()
    # Wait until EITHER direction ends (a relay is only as alive as its weakest
    # link). There is no age limit: a valid Agent task can run beyond five
    # minutes. Polling lets a finished direction promptly tear down its peer.
    while True:
        if not (t1.is_alive() and t2.is_alive()):
            break
        t1.join(timeout=0.05)
        t2.join(timeout=0.05)
    stop.set()
    # Shutdown first: it unblocks the peer's recv() so both pumps can exit,
    # instead of one side waiting forever on a socket that looks alive.
    for sock in (browser, upstream):
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    for sock in (browser, upstream):
        try:
            sock.close()
        except OSError:
            pass
    t1.join(timeout=1)
    t2.join(timeout=1)



# -- AI news feed -------------------------------------------------------------
# Fetched from public RSS feeds on demand, cached locally. No keys, no third-party
# services; the browser only ever reads the cached JSON from this gateway.

# 新闻源（行业动态 / 研究突破）
NEWS_SOURCES = [
    {"name": "量子位", "url": "https://www.qbitai.com/feed"},
    {"name": "MIT Tech", "url": "https://www.technologyreview.com/topic/artificial-intelligence/feed"},
    {"name": "HN ML", "url": "https://hnrss.org/newest?q=machine+learning"},
]

# 工具与主流模型动向源（产品更新 / 发布）。HuggingFace 在本机网络不可达，
# Anthropic 无公开 RSS（404），已移除；Google AI 响应慢，超时放宽。
TOOLS_SOURCES = [
    {"name": "OpenAI", "url": "https://openai.com/news/rss.xml"},
    {"name": "Google AI", "url": "https://blog.google/technology/ai/rss/"},
    {"name": "TechCrunch AI", "url": "https://techcrunch.com/category/artificial-intelligence/feed/"},
]

_NEWS_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_NEWS_OPENER.addheaders = [("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) BoujoyHarness/1.0")]
_NEWS_CACHE_SCHEMA = 3


def _parse_rss_date(value: str) -> datetime | None:
    if not value:
        return None
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S GMT", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value.strip(), fmt)
        except ValueError:
            continue
    try:
        return email.utils.parsedate_to_datetime(value.strip())
    except (TypeError, ValueError):
        return None


def _xml_local_name(tag: str) -> str:
    """Return an RSS/Atom tag name without its optional namespace."""
    return tag.rsplit("}", 1)[-1].rsplit(":", 1)[-1].lower()


def _feed_child_text(node: ET.Element, *names: str) -> str:
    wanted = {name.lower() for name in names}
    for child in node:
        if _xml_local_name(child.tag) in wanted and child.text:
            return child.text.strip()
    return ""


def _safe_news_image(value: str, base_url: str) -> str | None:
    candidate = html_lib.unescape(value or "").strip()
    if not candidate:
        return None
    candidate = urllib.parse.urljoin(base_url, candidate)
    parsed = urllib.parse.urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return candidate


def _extract_feed_image(item: ET.Element, base_url: str) -> str | None:
    """Prefer explicit RSS media, then fall back to the first body image."""
    for child in item.iter():
        name = _xml_local_name(child.tag)
        media_tag = "search.yahoo.com/mrss" in child.tag or name == "thumbnail"
        mime = (child.attrib.get("type") or "").lower()
        if name == "enclosure" and mime.startswith("image/"):
            image = _safe_news_image(child.attrib.get("url", ""), base_url)
            if image:
                return image
        if name in {"content", "thumbnail"} and (media_tag or mime.startswith("image/")):
            for attr in ("url", "src", "href"):
                image = _safe_news_image(child.attrib.get(attr, ""), base_url)
                if image:
                    return image

    html_blocks = [
        child.text or ""
        for child in item.iter()
        if _xml_local_name(child.tag) in {"description", "summary", "content", "encoded"}
    ]
    image_pattern = re.compile(
        r"<img\b[^>]*?\b(?:src|data-src|data-original)\s*=\s*(['\"])(.*?)\1",
        re.IGNORECASE | re.DOTALL,
    )
    for block in html_blocks:
        match = image_pattern.search(html_lib.unescape(block))
        if match:
            image = _safe_news_image(match.group(2), base_url)
            if image:
                return image
    return None


class _NewsImageMetaParser(HTMLParser):
    """Read a page's declared social cover without parsing its full document."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta_image = ""
        self.body_images: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name.lower(): value or "" for name, value in attrs}
        if tag.lower() == "meta":
            key = (values.get("property") or values.get("name") or "").lower()
            if not self.meta_image and key in {"og:image", "og:image:url", "twitter:image", "twitter:image:src"}:
                self.meta_image = values.get("content", "")
        elif tag.lower() == "link" and not self.meta_image and "image_src" in values.get("rel", "").lower():
            self.meta_image = values.get("href", "")
        elif tag.lower() == "img" and len(self.body_images) < 24:
            candidate = values.get("data-src") or values.get("data-original") or values.get("src") or ""
            if candidate:
                self.body_images.append(candidate)


def _looks_like_generic_news_image(value: str) -> bool:
    path = urllib.parse.unquote(urllib.parse.urlsplit(value).path).lower()
    return (
        path.endswith((".gif", ".svg"))
        or bool(re.search(r"[-_](?:\d{1,3})x(?:\d{1,3})(?:\.[a-z0-9]+)?$", path))
        or any(token in path for token in ("logo", "lockup", "icon", "favicon", "avatar", "qrcode", "placeholder", "default", "head.jpg"))
    )


def _same_feed_site(article_url: str, feed_url: str) -> bool:
    article_host = (urllib.parse.urlsplit(article_url).hostname or "").lower().removeprefix("www.")
    feed_host = (urllib.parse.urlsplit(feed_url).hostname or "").lower().removeprefix("www.")
    return bool(article_host and feed_host and (
        article_host == feed_host
        or article_host.endswith("." + feed_host)
        or feed_host.endswith("." + article_host)
    ))


def _fetch_article_image(article_url: str, feed_url: str) -> str | None:
    # Keep cover discovery scoped to the publisher that supplied the feed.
    if not _same_feed_site(article_url, feed_url):
        return None
    try:
        request = urllib.request.Request(article_url)
        with _NEWS_OPENER.open(request, timeout=12) as response:
            content_type = response.headers.get("Content-Type", "")
            if "html" not in content_type.lower():
                return None
            charset = response.headers.get_content_charset() or "utf-8"
            document = response.read(800000).decode(charset, errors="replace")
        parser = _NewsImageMetaParser()
        parser.feed(document)
        candidates = [parser.meta_image, *parser.body_images]
        generic_fallback = None
        for candidate in candidates:
            image = _safe_news_image(candidate, article_url)
            if not image:
                continue
            if _looks_like_generic_news_image(image):
                generic_fallback = generic_fallback or image
                continue
            return image
        return generic_fallback
    except Exception:
        return None


def _enrich_article_images(items: list[dict[str, Any]]) -> None:
    missing = [item for item in items if not item.get("image") and item.get("feedUrl")]
    if not missing:
        return
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(5, len(missing))) as pool:
        futures = {
            pool.submit(_fetch_article_image, item["url"], item["feedUrl"]): item
            for item in missing
        }
        for future in concurrent.futures.as_completed(futures):
            image = future.result()
            if image:
                futures[future]["image"] = image


def _fetch_rss_feed(source: dict[str, str], limit: int = 12) -> list[dict[str, Any]]:
    try:
        request = urllib.request.Request(source["url"])
        with _NEWS_OPENER.open(request, timeout=25) as response:
            data = response.read(500000)
        root = ET.fromstring(data)
    except Exception:
        return []
    items: list[dict[str, Any]] = []
    entries = [item for item in root.iter() if _xml_local_name(item.tag) in {"item", "entry"}]
    for item in entries:
        title = _feed_child_text(item, "title")
        link = _feed_child_text(item, "link")
        if not link:
            link_node = next((child for child in item if _xml_local_name(child.tag) == "link" and child.attrib.get("href")), None)
            link = link_node.attrib.get("href", "").strip() if link_node is not None else ""
        link = urllib.parse.urljoin(source["url"], link)
        if not title or not link:
            continue
        pub = _parse_rss_date(_feed_child_text(item, "pubDate", "published", "updated", "date"))
        description = _feed_child_text(item, "description", "summary", "content", "encoded")
        # Strip HTML tags for a clean summary.
        summary = html_lib.unescape(re.sub(r"<[^>]+>", " ", description)).strip()
        summary = re.sub(r"\s+", " ", summary)[:180]
        items.append({
            "title": html_lib.unescape(title),
            "url": link,
            "source": source["name"],
            "time": pub.isoformat() if pub else None,
            "summary": summary,
            "image": _extract_feed_image(item, source["url"]),
            "feedUrl": source["url"],
        })
        if len(items) >= limit:
            break
    return items


def _load_news_cache(cache_file: Path) -> dict[str, Any] | None:
    try:
        if not cache_file.is_file():
            return None
        data = json.loads(cache_file.read_text("utf-8"))
        fetched = datetime.fromisoformat(data.get("fetchedAt", "")).replace(tzinfo=None)
        if data.get("schema") == _NEWS_CACHE_SCHEMA and datetime.now() - fetched < timedelta(hours=6):
            return data
    except (ValueError, KeyError, OSError):
        return None
    return None


def _collect_feed(sources: list[dict[str, str]], cutoff: datetime, limit: int) -> list[dict[str, Any]]:
    all_items: list[dict[str, Any]] = []
    for source in sources:
        all_items.extend(_fetch_rss_feed(source))
    seen = set()
    filtered: list[dict[str, Any]] = []
    for item in sorted(all_items, key=lambda it: it.get("time") or "", reverse=True):
        if item.get("time"):
            try:
                item_time = datetime.fromisoformat(item["time"].replace("Z", "+00:00"))
                if item_time.tzinfo:
                    item_time = item_time.replace(tzinfo=None)
                if item_time < cutoff:
                    continue
            except ValueError:
                pass
        key = item["url"]
        if key in seen:
            continue
        seen.add(key)
        filtered.append(item)
        if len(filtered) >= limit:
            break
    _enrich_article_images(filtered)
    for item in filtered:
        item.pop("feedUrl", None)
    return filtered


def _fetch_news_into_cache(cache_file: Path) -> dict[str, Any]:
    now = datetime.now()
    cutoff = now - timedelta(days=3)
    news = _collect_feed(NEWS_SOURCES, cutoff, 10)
    tools = _collect_feed(TOOLS_SOURCES, cutoff, 10)
    result = {"schema": _NEWS_CACHE_SCHEMA, "fetchedAt": now.isoformat(), "news": news, "tools": tools}
    try:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache_file.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False), "utf-8")
        temporary.replace(cache_file)
    except OSError:
        pass
    return result



class AppConfig:
    def __init__(self, vault: Path, static: Path, knowledge_home: Path | None = None, clean_home: Path | None = None):
        self.vault = vault.resolve()
        self.static = static.resolve()
        self.knowledge_home = knowledge_home.resolve() if knowledge_home else None
        self.clean_home = clean_home.resolve() if clean_home else None
        self.access_code: str = ""
        # Keep mutable product data out of the shared portable package. macOS
        # keeps its existing Application Support location; Windows uses the
        # documented per-user LocalAppData location instead of a fake
        # ``~/Library`` tree.
        if os.name == "nt":
            local_app_data = os.environ.get("LOCALAPPDATA")
            state_base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
            self.product_state = state_base / "Boujoy" / "BoujoyHarness"
        else:
            self.product_state = Path.home() / "Library" / "Application Support" / "Boujoy" / "BoujoyHarness"
        self.deleted_sessions_file = self.product_state / "deleted-sessions.json"
        self.restart_file: Path | None = None
        if os.name == "nt":
            discovered_ffmpeg = shutil.which("ffmpeg.exe") or shutil.which("ffmpeg")
            self.ffmpeg_path = Path(discovered_ffmpeg) if discovered_ffmpeg else None
        else:
            self.ffmpeg_path = next(
                (Path(p) for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg") if Path(p).is_file()),
                None,
            )
        self.records = {
            "expert": self.vault / "05-Prompts" / "Boujoy-Harness" / "Experts",
            "style": self.vault / "05-Prompts" / "Boujoy-Harness" / "Styles",
        }

    @property
    def trash_directory(self) -> Path:
        # Windows does not expose a reliable filesystem Recycle Bin path.
        # Retain Boujoy's existing recoverable-delete behavior in per-user
        # product state instead of pretending that ``~/.Trash`` exists there.
        return self.product_state / "Trash" if os.name == "nt" else Path.home() / ".Trash"

    def request_managed_restart(self) -> None:
        """Ask an external platform host to restart all local services.

        The native macOS host owns its restart via SIGUSR1. Windows uses a
        PowerShell service host instead, where a small atomic signal file is
        safer than trying to terminate the process that is serving this HTTP
        response.
        """
        if self.restart_file is None:
            raise RuntimeError("managed restart is not configured")
        target = self.restart_file
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f"{target.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        temporary.write_text(
            json.dumps({"requestedAt": time.time(), "pid": os.getpid()}, separators=(",", ":")),
            "utf-8",
        )
        temporary.replace(target)


class BoujoyHandler(BaseHTTPRequestHandler):
    server_version = "BoujoyHarness/1.0"
    protocol_version = "HTTP/1.1"

    @property
    def config(self) -> AppConfig:
        return self.server.config  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        if os.environ.get("BOUJOY_DEBUG") == "1":
            super().log_message(fmt, *args)

    def _headers(self, status: int, content_type: str, length: int | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        # Local-only gateway: only loopback product surfaces (8766 shell, 3080/
        # 3081 harness, file:// preview) may consume the APIs. Arbitrary web
        # origins get no CORS headers, so a random site cannot read the vault
        # or drive write endpoints from the browser.
        origin = self.headers.get("Origin", "")
        if origin and _origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Credentials", "true")
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.end_headers()

    def _json(self, value: Any, status: int = 200) -> None:
        body = compact_json(value)
        self._headers(status, "application/json; charset=utf-8", len(body))
        # Some vault responses contain several megabytes of Markdown. Writing
        # the entire body in one socket call can stall WebKit behind a slow or
        # concurrently reloading client, leaving the product on a skeleton.
        # Bounded chunks preserve the exact payload while allowing progress.
        try:
            view = memoryview(body)
            for offset in range(0, len(body), 64 * 1024):
                self.wfile.write(view[offset:offset + 64 * 1024])
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

    def _error(self, status: int, message: str) -> None:
        self._json({"ok": False, "error": message}, status)

    def _read_json(self) -> dict[str, Any]:
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size > 4 * 1024 * 1024:
                raise ValueError("request too large")
            return json.loads(self.rfile.read(size) or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            raise ValueError("无效请求") from exc

    def _serve_static(self, url_path: str) -> None:
        relative = urllib.parse.unquote(url_path).lstrip("/") or "index.html"
        candidate = (self.config.static / relative).resolve()
        try:
            candidate.relative_to(self.config.static)
        except ValueError:
            self._error(403, "forbidden")
            return
        if not candidate.is_file():
            candidate = self.config.static / "index.html"
        try:
            data = candidate.read_bytes()
        except OSError:
            self._error(404, "not found")
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
            content_type += "; charset=utf-8"
        self._headers(200, content_type, len(data))
        self.wfile.write(data)

    def _proxy(self, target: str, method: str = "GET", body: bytes | None = None, stream: bool = False, filter_deleted: bool = False) -> None:
        headers = {
            "Accept": self.headers.get("Accept", "application/json"),
            "User-Agent": "Boujoy-Harness/1.0",
        }
        if body is not None:
            headers["Content-Type"] = self.headers.get("Content-Type", "application/json")
        if target.startswith(KB_ORIGIN):
            headers.update({
                "Origin": KB_ORIGIN,
                "Referer": KB_ORIGIN + "/",
                "Sec-Fetch-Site": "same-origin",
                "Sec-Fetch-Mode": "cors",
            })
        request = urllib.request.Request(target, data=body, headers=headers, method=method)
        try:
            with LOCAL_OPENER.open(request, timeout=3600 if stream else 20) as response:
                content_type = response.headers.get("Content-Type", "application/octet-stream")
                if stream:
                    self.send_response(response.status)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Connection", "keep-alive")
                    self.end_headers()
                    while True:
                        chunk = response.read(8192)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                else:
                    data = response.read()
                    if filter_deleted and "json" in content_type.lower():
                        try:
                            data = compact_json(self._filter_deleted_listings(json.loads(data)))
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            pass
                    self._headers(response.status, content_type, len(data))
                    self.wfile.write(data)
        except urllib.error.HTTPError as exc:
            data = exc.read() or compact_json({"ok": False, "error": str(exc)})
            self._headers(exc.code, exc.headers.get("Content-Type", "application/json"), len(data))
            self.wfile.write(data)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            self._error(502, f"本地服务未就绪：{getattr(exc, 'reason', exc)}")
        except (BrokenPipeError, ConnectionResetError):
            return

    def _record_folder(self, kind: str) -> Path:
        if kind not in self.config.records:
            raise ValueError("未知类型")
        folder = self.config.records[kind]
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def _safe_vault_path(self, relative: str, *, require_markdown: bool = False, reject_symlinks: bool = False) -> Path:
        if not relative or "\x00" in relative:
            raise ValueError("无效路径")
        lexical = Path(os.path.abspath(self.config.vault / relative))
        try:
            lexical.relative_to(self.config.vault)
        except ValueError as exc:
            raise PermissionError("路径位于 Vault 之外") from exc
        if reject_symlinks:
            current = self.config.vault
            for part in lexical.relative_to(self.config.vault).parts:
                current /= part
                if current.is_symlink():
                    raise PermissionError("不能修改符号链接路径")
        target = lexical.resolve(strict=True)
        try:
            target.relative_to(self.config.vault)
        except ValueError as exc:
            raise PermissionError("路径位于 Vault 之外") from exc
        if require_markdown and target.suffix.lower() != ".md":
            raise PermissionError("只允许处理 Markdown 文件")
        return target

    CONVERSATION_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
    CONVERSATION_VIDEO_EXTS = (".mp4", ".webm", ".mov", ".m4v")

    def _safe_conversation_media_path(self, value: str) -> Path:
        """Resolve a chat preview without turning the gateway into an
        arbitrary local-file server. Only image/video files under the Vault,
        Harness homes, or the user's normal media folders are eligible."""
        source = urllib.parse.unquote(str(value or "").strip())
        if not source or "\x00" in source:
            raise ValueError("无效媒体路径")
        if source.lower().startswith("file://"):
            source = urllib.parse.unquote(urllib.parse.urlsplit(source).path)
            if os.name == "nt" and re.match(r"^/[A-Za-z]:/", source):
                source = source[1:]
        candidate = Path(source).expanduser()
        if not candidate.is_absolute():
            candidate = self.config.vault / candidate
        target = candidate.resolve(strict=True)
        if not target.is_file():
            raise ValueError("不是文件")
        if target.suffix.lower() not in self.CONVERSATION_IMAGE_EXTS + self.CONVERSATION_VIDEO_EXTS:
            raise PermissionError("只允许预览图片和视频")
        home = Path.home()
        roots = [
            self.config.vault,
            self.config.knowledge_home,
            self.config.clean_home,
            *(home / name for name in ("Desktop", "Downloads", "Pictures", "Movies", "Videos")),
        ]
        for root in roots:
            if root is None:
                continue
            try:
                target.relative_to(root.resolve())
                return target
            except (OSError, ValueError):
                continue
        raise PermissionError("媒体路径不在允许的本机目录中")

    def _stream_conversation_media(self, target: Path) -> None:
        size = target.stat().st_size
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if not (content_type.startswith("image/") or content_type.startswith("video/")):
            raise PermissionError("文件类型不可预览")
        range_header = self.headers.get("Range") if content_type.startswith("video/") else None
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip(), flags=re.IGNORECASE)
            if match:
                start = int(match.group(1)) if match.group(1) else 0
                end = int(match.group(2)) if match.group(2) else size - 1
                end = min(end, size - 1)
                if start < 0 or start >= size or end < start:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                length = end - start + 1
                self.send_response(206)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(length))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                with target.open("rb") as fh:
                    fh.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = fh.read(min(64 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        if content_type.startswith("video/"):
            self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with target.open("rb") as fh:
            while True:
                chunk = fh.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)

    MEDIA_EXTS = (".mp4", ".webm", ".mov")
    # Intermediate render fragments and caches are not deliverables. Manim's
    # media/ tree is the render cache (every frame partial); finished videos
    # live under outputs_* / dist / previews / output.
    MEDIA_SKIP_SEGMENTS = ("partial_movie_files", "manim/media/", "output/media-")

    def _is_deliverable_media(self, relative: str) -> bool:
        lowered = relative.lower()
        if not lowered.endswith(self.MEDIA_EXTS):
            return False
        for segment in self.MEDIA_SKIP_SEGMENTS:
            if segment in lowered:
                return False
        return True

    def _vault_files(self, *, compact: bool = False) -> list[dict[str, Any]]:
        # Cache keyed by a cheap file-signature: path + size + mtime for every
        # markdown file. A compact listing can then be served without rescanning
        # the whole vault on every refresh. The signature walk is O(files) stat
        # calls but avoids re-reading every file's full text.
        try:
            signature = []
            for current, directories, names in os.walk(self.config.vault):
                directories[:] = sorted(name for name in directories if name not in IGNORED_DIRS)
                for name in sorted(names):
                    lowered = name.lower()
                    if not (lowered.endswith(".md") or lowered.endswith(self.MEDIA_EXTS)):
                        continue
                    if lowered.endswith(self.MEDIA_EXTS):
                        relative = (Path(current) / name).resolve().relative_to(self.config.vault).as_posix()
                        if not self._is_deliverable_media(relative):
                            continue
                    try:
                        st = (Path(current) / name).stat()
                    except OSError:
                        continue
                    signature.append((st.st_mtime_ns, st.st_size, current, name))
            # Keep full and compact vault listings in separate cache slots.
            # Reusing the first response for the other mode either leaks the
            # full text into compact responses or truncates normal listings.
            key = (compact, tuple(signature))
        except OSError:
            key = None
        if key is not None and self.server.vault_cache.get(key) is not None:
            return self.server.vault_cache[key]
        files: list[dict[str, Any]] = []
        for current, directories, names in os.walk(self.config.vault):
            directories[:] = sorted(name for name in directories if name not in IGNORED_DIRS)
            folder = Path(current)
            for name in sorted(names):
                lowered = name.lower()
                path = folder / name
                try:
                    resolved = path.resolve(strict=True)
                    relative = resolved.relative_to(self.config.vault).as_posix()
                    stat = resolved.stat()
                except (OSError, ValueError):
                    continue
                if lowered.endswith(".md"):
                    try:
                        text = resolved.read_text("utf-8", errors="replace")
                    except OSError:
                        continue
                    truncated = compact and len(text) > 128 * 1024
                    files.append({
                        "path": relative,
                        "text": text[:128 * 1024] if truncated else text,
                        "lastModified": stat.st_mtime * 1000,
                        "size": stat.st_size,
                        "truncated": truncated,
                    })
                elif self._is_deliverable_media(relative):
                    # Video entries: metadata only (never read content into the
                    # index). Playback uses the /api/knowledge/media endpoint.
                    files.append({
                        "path": relative,
                        "media": True,
                        "mediaType": "video",
                        "lastModified": stat.st_mtime * 1000,
                        "size": stat.st_size,
                    })
        if key is not None:
            # Keep one generation so repeated refreshes are cheap.
            self.server.vault_cache = {key: files}
        return files

    @staticmethod
    def _protected_markdown(relative: str) -> bool:
        normalized = relative.replace("\\", "/").lower()
        return normalized in PROTECTED_MARKDOWN_FILES or normalized.startswith(PROTECTED_MARKDOWN_ROOTS)

    def _cleanup_candidates(self) -> set[str]:
        report = self.config.vault / "00-System" / "Cleanup-Candidates.md"
        if not report.is_file():
            return set()
        text = report.read_text("utf-8", errors="replace")
        text = re.split(r"^## E\. 完全重复的 Markdown\s*$", text, maxsplit=1, flags=re.MULTILINE)[0]
        return {
            value.strip().replace("\\", "/")
            for value in re.findall(r"`([^`]+)`", text)
            if value.strip() and not value.strip().startswith(("00-System/", "tools/"))
        }

    def _move_to_trash(self, paths: list[Path]) -> None:
        trash = self.config.trash_directory
        trash.mkdir(parents=True, exist_ok=True)
        for path in paths:
            destination = trash / path.name
            if destination.exists():
                destination = trash / f"{path.stem}-{datetime.now().strftime('%Y%m%d%H%M%S')}{path.suffix}"
            shutil.move(str(path), str(destination))

    def _trash_session_logs(self, session_id: str, mode: str) -> int:
        if not re.fullmatch(r"(?:session-)?[a-zA-Z0-9][a-zA-Z0-9-]{7,90}", session_id):
            raise ValueError("无效会话 ID")
        home = self.config.clean_home if mode == "clean" else self.config.knowledge_home
        if home is None:
            raise ValueError("Harness 会话目录未配置")
        root = (home / "sessions").resolve(strict=True)
        targets: list[Path] = []
        for candidate in root.glob(f"*/{session_id}"):
            resolved = candidate.resolve(strict=True)
            try:
                resolved.relative_to(root)
            except ValueError as exc:
                raise PermissionError("会话目录越界") from exc
            if resolved.is_dir() and resolved.name == session_id:
                targets.append(resolved)
        trash = self.config.trash_directory
        trash.mkdir(parents=True, exist_ok=True)
        for target in targets:
            destination = trash / f"Boujoy-Session-{session_id}"
            if destination.exists():
                destination = trash / f"Boujoy-Session-{session_id}-{datetime.now().strftime('%Y%m%d%H%M%S')}"
            shutil.move(str(target), str(destination))
        self._record_deleted_session(session_id)
        return len(targets)

    @staticmethod
    def _session_id_from_trash_name(name: str) -> str | None:
        match = re.match(r"^Boujoy-Session-((?:session-)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:-|$)", name)
        return match.group(1) if match else None

    def _deleted_session_ids(self) -> set[str]:
        values: set[str] = set()
        try:
            stored = json.loads(self.config.deleted_sessions_file.read_text("utf-8"))
            if isinstance(stored, list):
                values.update(str(item) for item in stored)
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            pass
        trash = self.config.trash_directory
        if trash.is_dir():
            for path in trash.glob("Boujoy-Session-*"):
                session_id = self._session_id_from_trash_name(path.name)
                if session_id:
                    values.add(session_id)
        return values

    def _record_deleted_session(self, session_id: str) -> None:
        values = self._deleted_session_ids()
        values.add(session_id)
        self.config.product_state.mkdir(parents=True, exist_ok=True)
        temporary = self.config.deleted_sessions_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(sorted(values), ensure_ascii=False, indent=2) + "\n", "utf-8")
        temporary.replace(self.config.deleted_sessions_file)

    def _filter_deleted_listings(self, value: Any) -> Any:
        deleted = self._deleted_session_ids()
        if not deleted:
            return value

        def visit(item: Any) -> Any:
            if isinstance(item, list):
                return [visit(child) for child in item if not (isinstance(child, dict) and str(child.get("sessionId") or child.get("id") or "") in deleted)]
            if isinstance(item, dict):
                filtered: dict[str, Any] = {}
                for key, child in item.items():
                    if key in {"sessionIds", "archivedSessionIds"} and isinstance(child, list):
                        filtered[key] = [session_id for session_id in child if str(session_id) not in deleted]
                    else:
                        filtered[key] = visit(child)
                return filtered
            return item

        return visit(value)

    def _parse_record(self, path: Path) -> dict[str, Any] | None:
        try:
            text = path.read_text("utf-8")
        except OSError:
            return None
        fields: dict[str, str] = {}
        if text.startswith("---"):
            pieces = text.split("---", 2)
            if len(pieces) == 3:
                for line in pieces[1].splitlines():
                    key, sep, value = line.partition(":")
                    if sep:
                        fields[key.strip()] = value.strip().strip('"')
        split = re.search(r"^##\s+(?:指令|Instructions)\s*$", text, re.M)
        instructions = text[split.end():].strip() if split else text.strip()
        return {
            "id": path.stem,
            "name": fields.get("name") or path.stem,
            "description": fields.get("description", ""),
            "enabled": fields.get("enabled", "true").lower() != "false",
            "instructions": instructions,
            "updated": fields.get("updated", ""),
        }

    def _list_records(self, kind: str) -> list[dict[str, Any]]:
        folder = self._record_folder(kind)
        records = [self._parse_record(path) for path in sorted(folder.glob("*.md"))]
        return [item for item in records if item]

    def _save_record(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        folder = self._record_folder(kind)
        name = str(payload.get("name", "")).strip()
        description = str(payload.get("description", "")).strip()
        instructions = str(payload.get("instructions", "")).strip()
        if not name or not instructions:
            raise ValueError("名称和指令不能为空")
        record_id = str(payload.get("id", "")).strip()
        if record_id and not re.fullmatch(r"[\w\-\u4e00-\u9fff]+", record_id):
            raise ValueError("无效记录 ID")
        if not record_id:
            base = safe_slug(name)
            record_id = base
            index = 2
            while (folder / f"{record_id}.md").exists():
                record_id = f"{base}-{index}"
                index += 1
        enabled = bool(payload.get("enabled", True))
        updated = datetime.now(timezone.utc).isoformat(timespec="seconds")
        text = (
            "---\n"
            f"type: boujoy-{kind}\n"
            f"name: {yaml_string(name)}\n"
            f"description: {yaml_string(description)}\n"
            f"enabled: {'true' if enabled else 'false'}\n"
            f"updated: {updated}\n"
            "---\n\n"
            f"# {name}\n\n"
            "## 指令\n\n"
            f"{instructions}\n"
        )
        target = folder / f"{record_id}.md"
        temporary = target.with_suffix(".md.tmp")
        temporary.write_text(text, "utf-8")
        temporary.replace(target)
        return self._parse_record(target) or {"id": record_id}

    def _delete_record(self, kind: str, record_id: str) -> None:
        if not re.fullmatch(r"[\w\-\u4e00-\u9fff]+", record_id):
            raise ValueError("无效记录 ID")
        target = self._record_folder(kind) / f"{record_id}.md"
        if not target.exists():
            raise ValueError("记录不存在")
        trash = self.config.trash_directory
        trash.mkdir(parents=True, exist_ok=True)
        destination = trash / target.name
        if destination.exists():
            destination = trash / f"{target.stem}-{datetime.now().strftime('%Y%m%d%H%M%S')}.md"
        shutil.move(str(target), str(destination))

    # -- Knowledge capture ----------------------------------------------------
    # The model decides VALUE (score) and COMPRESSION (card text). This server
    # only enforces SAFETY: writable directories, protected files, atomic
    # replace, and optional dedup-by-path. It never fabricates content.

    CAPTURE_ROOTS = ("02-projects/", "03-knowledge/", "04-content/", "05-prompts/", "06-business/")

    def _capture_destination(self, relative: str) -> Path:
        """Resolve a capture target strictly inside the vault and in a writable root."""
        if not relative or "\x00" in relative:
            raise ValueError("无效路径")
        normalized = relative.replace("\\", "/")
        if not normalized.lower().endswith(".md"):
            raise ValueError("只允许写入 Markdown 文件")
        lowered = normalized.lower()
        if not lowered.startswith(self.CAPTURE_ROOTS):
            raise PermissionError("该目录不允许自动沉淀，请写到 02-06 主题目录或 Memory-Queue")
        if self._protected_markdown(normalized):
            raise PermissionError("系统、索引、UI 和 Skills 文件受保护")
        lexical = Path(os.path.abspath(self.config.vault / normalized))
        try:
            lexical.relative_to(self.config.vault)
        except ValueError as exc:
            raise PermissionError("路径位于 Vault 之外") from exc
        current = self.config.vault
        for part in lexical.relative_to(self.config.vault).parts[:-1]:
            current /= part
            if current.is_symlink():
                raise PermissionError("不能写入符号链接目录")
        return lexical

    @staticmethod
    def _capture_kind_for(relative: str) -> str:
        lowered = relative.lower()
        if lowered.startswith("02-projects/"):
            return "project"
        if lowered.startswith("03-knowledge/"):
            return "knowledge"
        if lowered.startswith("04-content/"):
            return "content"
        if lowered.startswith("05-prompts/"):
            return "prompt"
        if lowered.startswith("06-business/"):
            return "business"
        return "other"

    @staticmethod
    def _text_similarity(a: str, b: str) -> float:
        """Jaccard-like similarity over character bigrams. Cheap, no deps."""
        def bigrams(text: str) -> set[str]:
            cleaned = re.sub(r"[\s#*_`|\[\]()（）\-—・]+", "", text).casefold()
            return {cleaned[i:i + 2] for i in range(len(cleaned) - 1)} if len(cleaned) > 1 else set(cleaned)
        ba, bb = bigrams(a), bigrams(b)
        if not ba or not bb:
            return 0.0
        inter = len(ba & bb)
        return inter / (len(ba) + len(bb) - inter)

    def _dedup_check(self, target: Path, text: str) -> dict[str, Any] | None:
        """Scan the target directory for an existing card that would make this
        write a duplicate. Returns {path, score} of the closest hit when it
        exceeds the threshold, else None."""
        if target.parent == (self.config.vault / "00-System"):
            return None  # Memory-Queue is an append-only candidate list.
        threshold = 0.62
        best: tuple[float, Path] | None = None
        try:
            for existing in target.parent.glob("*.md"):
                if existing.resolve() == target.resolve():
                    continue
                try:
                    existing_text = existing.read_text("utf-8", errors="replace")
                except OSError:
                    continue
                score = self._text_similarity(text, existing_text)
                if score >= threshold and (best is None or score > best[0]):
                    best = (score, existing)
        except OSError:
            return None
        if best is None:
            return None
        try:
            rel = best[1].resolve().relative_to(self.config.vault.resolve()).as_posix()
        except ValueError:
            rel = best[1].name
        return {"path": rel, "score": round(best[0], 2)}

    def _capture_write(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Atomic, protected, symlink-safe write of a model-compressed knowledge card."""
        relative = str(payload.get("path", "")).strip()
        if not relative:
            raise ValueError("缺少目标路径")
        if relative.lower() == "00-system/memory-queue.md":
            target = self.config.vault / "00-System" / "Memory-Queue.md"
            if not target.parent.exists():
                raise ValueError("Memory-Queue 目录不存在")
        else:
            target = self._capture_destination(relative)
        text = str(payload.get("text", "")).strip()
        if len(text) < 20:
            raise ValueError("沉淀内容过短")
        if len(text) > 64 * 1024:
            raise ValueError("沉淀内容过长（超过 64KB）")
        # Dedup guard: refuse to create a near-duplicate card. The model should
        # append an update to the existing card instead of piling up copies.
        hit = self._dedup_check(target, text)
        if hit is not None:
            raise PermissionError(
                f"检测到高度相似的知识卡 {hit['path']}（相似度 {hit['score']:.0%}）。"
                "请追加到原卡的更新记录，不要新建重复卡片。"
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".md.tmp")
        temporary.write_text(text + ("\n" if not text.endswith("\n") else ""), "utf-8")
        temporary.replace(target)
        # Invalidate the vault listing cache so the new card shows immediately.
        self.server.vault_cache = {}
        return {
            "ok": True,
            "path": target.relative_to(self.config.vault).as_posix(),
            "kind": self._capture_kind_for(target.relative_to(self.config.vault).as_posix()),
        }

    def do_OPTIONS(self) -> None:
        # CORS preflight: only loopback product surfaces get the go-ahead.
        self.send_response(204)
        origin = self.headers.get("Origin", "")
        if origin and _origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    @staticmethod
    def _lan_ip() -> str:
        """Best-effort LAN IP of this Mac (no deps): open a UDP socket to a
        public address — no packets are actually sent."""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except OSError:
            return ""

    def _require_access(self, parsed: urllib.parse.SplitResult) -> bool:
        """Gate non-loopback clients behind the access code.

        Only the actual peer address may grant the loopback exemption. Host
        and Origin are caller-controlled headers, so trusting either here lets
        a LAN client spoof ``Host: 127.0.0.1`` and bypass phone pairing.
        """
        if not self.config.access_code:
            return True
        try:
            if ipaddress.ip_address(str(self.client_address[0])).is_loopback:
                return True
        except ValueError:
            pass
        provided = self.headers.get("X-Boujoy-Access", "") or urllib.parse.parse_qs(parsed.query).get("access", [""])[0]
        client = str(self.client_address[0])
        now = time.monotonic()
        with self.server.access_attempt_lock:  # type: ignore[attr-defined]
            attempts = [
                stamp for stamp in self.server.access_attempts.get(client, [])  # type: ignore[attr-defined]
                if now - stamp < 60
            ]
            if len(attempts) >= 10:
                self.server.access_attempts[client] = attempts  # type: ignore[attr-defined]
                return False
            if hmac.compare_digest(str(provided), str(self.config.access_code)):
                self.server.access_attempts.pop(client, None)  # type: ignore[attr-defined]
                return True
            attempts.append(now)
            self.server.access_attempts[client] = attempts  # type: ignore[attr-defined]
            return False

    def _request_origin_allowed(self, origin: str) -> bool:
        """Accept built-in loopback surfaces and the phone page's exact LAN
        same-origin URL. Requiring a literal private/loopback IP for the latter
        also closes the DNS-rebinding case (attacker.example -> 127.0.0.1)."""
        if _origin_allowed(origin):
            return True
        try:
            parsed = urllib.parse.urlsplit(origin)
            server_port = int(self.server.server_address[1])  # type: ignore[attr-defined]
            origin_port = parsed.port or (80 if parsed.scheme == "http" else 443)
            address = ipaddress.ip_address(parsed.hostname or "")
        except (TypeError, ValueError, AttributeError):
            return False
        if parsed.scheme != "http" or origin_port != server_port:
            return False
        if not (address.is_loopback or address.is_private or address.is_link_local):
            return False
        return parsed.netloc.lower() == self.headers.get("Host", "").strip().lower()

    def _deny_access(self) -> None:
        self._error(401, "需要访问码（Boujoy Access Code）")

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        # Static assets load without the code so a phone can fetch the login
        # page first; every /api/ call (including the page's own fetches) is
        # gated. The frontend remembers the code and sends it on all calls.
        if path.startswith("/api/") and not self._require_access(parsed):
            self._deny_access()
            return
        if path == "/api/heartbeat":
            self._json({"ok": True, "product": "Boujoy Harness"})
            return
        if path == "/api/health":
            # This is intentionally the product gateway's readiness signal.
            # The optional standalone knowledge preview and lazy clean Harness
            # are not prerequisites for rendering the main product shell.
            self._json({"ok": True, "ready": True, "pid": os.getpid(), "services": {"product": True, "gateway": True}})
            return
        if path == "/api/config":
            self._json({"ok": True, "vaultName": self.config.vault.name})
            return
        if path == "/api/access-info":
            # Phone-pairing guide data: LAN IP + access code. The code is only
            # meaningful on this machine anyway (loopback-only service), and
            # the endpoint itself is gated by the same access code for remote
            # callers, so exposing it here is safe.
            lan_ip = self._lan_ip()
            self._json({
                "ok": True,
                "lanIp": lan_ip or "未知",
                "port": 8766,
                "accessCode": self.config.access_code,
                "url": f"http://{lan_ip}:8766" if lan_ip else "http://<Mac 局域网IP>:8766",
            })
            return
        if path == "/api/knowledge/vault":
            compact = urllib.parse.parse_qs(parsed.query).get("compact", ["0"])[0] == "1"
            self._json({"root": self.config.vault.name, "files": self._vault_files(compact=compact), "skipped": [], "unreadable": []})
            return
        if path == "/api/knowledge/search":
            query = urllib.parse.parse_qs(parsed.query).get("q", [""])[0].strip().casefold()
            if not query:
                self._json({"ok": True, "paths": []})
                return
            # Lightweight CJK-aware query split: whole tokens first, then
            # character bigrams, so short Chinese queries ("强化学习", "蒸馏")
            # match inside longer text without a full-text engine.
            def query_terms(text: str) -> set[str]:
                tokens = {part for part in re.split(r"[^\w\u4e00-\u9fff]+", text) if part}
                bigrams = {text[i:i + 2] for i in range(len(text) - 1) if "\u4e00" <= text[i] <= "\u9fff" and "\u4e00" <= text[i + 1] <= "\u9fff"}
                return tokens | bigrams
            wanted = query_terms(query)
            if not wanted:
                self._json({"ok": True, "paths": []})
                return
            matches = []
            for item in self._vault_files():
                haystack = item["path"].casefold() + "\n" + item["text"].casefold()
                if query in haystack or wanted & query_terms(haystack):
                    matches.append(item["path"])
            self._json({"ok": True, "paths": matches[:500]})
            return
        if path == "/api/knowledge/file":
            try:
                relative = urllib.parse.parse_qs(parsed.query).get("path", [""])[0]
                target = self._safe_vault_path(relative)
                if not target.is_file():
                    raise ValueError("不是文件")
                content_type = mimetypes.guess_type(target.name)[0] or "text/plain"
                if target.suffix.lower() == ".md" or content_type.startswith("text/"):
                    self._json({"path": relative, "text": target.read_text("utf-8", errors="replace")})
                else:
                    data = target.read_bytes()
                    self._headers(200, content_type, len(data))
                    self.wfile.write(data)
            except FileNotFoundError:
                self._error(404, "文件不存在")
            except PermissionError as exc:
                self._error(403, str(exc))
            except (ValueError, OSError) as exc:
                self._error(400, str(exc))
            return
        if path == "/api/news":
            # AI news + tools feed. Default: cached (<=6h). ?refresh=1 forces a
            # fresh crawl of the RSS sources.
            try:
                news_file = self.config.product_state / "news.json"
                refresh = urllib.parse.parse_qs(parsed.query).get("refresh", ["0"])[0] == "1"
                if refresh:
                    data = _fetch_news_into_cache(news_file)
                else:
                    data = _load_news_cache(news_file)
                    if data is None:
                        data = _fetch_news_into_cache(news_file)
                self._json({"ok": True, "fetchedAt": data.get("fetchedAt"), "news": data.get("news", []), "tools": data.get("tools", [])})
                return
            except (ValueError, OSError) as exc:
                self._error(502, str(exc))
                return
        if path == "/api/news/image":
            # Thumbnail proxy/cache for publishers that reject direct hotlinks.
            # Requests are allowed only for an exact image/article pair already
            # present in our own news cache, so this cannot become an open proxy.
            try:
                params = urllib.parse.parse_qs(parsed.query)
                image_url = params.get("url", [""])[0]
                article_url = params.get("article", [""])[0]
                news_file = self.config.product_state / "news.json"
                cached_feed = json.loads(news_file.read_text("utf-8"))
                allowed = any(
                    item.get("image") == image_url and item.get("url") == article_url
                    for item in [*cached_feed.get("news", []), *cached_feed.get("tools", [])]
                )
                if not allowed:
                    raise PermissionError("缩略图不在当前新闻缓存中")

                suffix = Path(urllib.parse.urlsplit(image_url).path).suffix.lower()
                if suffix not in {".jpg", ".jpeg", ".png", ".webp", ".avif"}:
                    suffix = ".img"
                thumb_dir = self.config.product_state / "news-thumbs"
                thumb_file = thumb_dir / f"{hashlib.sha256(image_url.encode('utf-8')).hexdigest()}{suffix}"
                content_type = mimetypes.guess_type(thumb_file.name)[0]
                if thumb_file.is_file() and time.time() - thumb_file.stat().st_mtime < 7 * 86400:
                    data = thumb_file.read_bytes()
                    self._headers(200, content_type or "application/octet-stream", len(data))
                    self.wfile.write(data)
                    return

                request = urllib.request.Request(image_url, headers={"Referer": article_url})
                with _NEWS_OPENER.open(request, timeout=18) as response:
                    remote_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                    if not remote_type.startswith("image/"):
                        raise ValueError("远端内容不是图片")
                    data = response.read(6 * 1024 * 1024 + 1)
                if len(data) > 6 * 1024 * 1024:
                    raise ValueError("缩略图超过 6MB")
                try:
                    thumb_dir.mkdir(parents=True, exist_ok=True)
                    temporary = thumb_file.with_suffix(thumb_file.suffix + ".tmp")
                    temporary.write_bytes(data)
                    temporary.replace(thumb_file)
                except OSError:
                    pass
                self._headers(200, remote_type, len(data))
                self.wfile.write(data)
                return
            except FileNotFoundError:
                self._error(404, "新闻缓存不存在")
                return
            except PermissionError as exc:
                self._error(403, str(exc))
                return
            except (ValueError, OSError, json.JSONDecodeError, urllib.error.URLError) as exc:
                self._error(502, str(exc))
                return
        if path == "/api/conversation/media":
            try:
                value = urllib.parse.parse_qs(parsed.query).get("path", [""])[0]
                target = self._safe_conversation_media_path(value)
                self._stream_conversation_media(target)
            except FileNotFoundError:
                self._error(404, "媒体文件不存在")
            except PermissionError as exc:
                self._error(403, str(exc))
            except (ValueError, OSError) as exc:
                self._error(400, str(exc))
            return
        if path == "/api/knowledge/media":
            # Stream a vault video with HTTP Range support so <video> can seek.
            try:
                relative = urllib.parse.parse_qs(parsed.query).get("path", [""])[0]
                target = self._safe_vault_path(relative)
                if not target.is_file():
                    raise ValueError("不是文件")
                if target.suffix.lower() not in self.MEDIA_EXTS:
                    raise PermissionError("只允许访问视频文件")
                size = target.stat().st_size
                content_type = mimetypes.guess_type(target.name)[0] or "video/mp4"
                range_header = self.headers.get("Range")
                if range_header:
                    match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip(), flags=re.IGNORECASE)
                    if match:
                        start = int(match.group(1)) if match.group(1) else 0
                        end = int(match.group(2)) if match.group(2) else size - 1
                        end = min(end, size - 1)
                        length = end - start + 1
                        self.send_response(206)
                        self.send_header("Content-Type", content_type)
                        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                        self.send_header("Accept-Ranges", "bytes")
                        self.send_header("Content-Length", str(length))
                        self.send_header("Cache-Control", "no-store")
                        self.end_headers()
                        with target.open("rb") as fh:
                            fh.seek(start)
                            remaining = length
                            while remaining > 0:
                                chunk = fh.read(min(64 * 1024, remaining))
                                if not chunk:
                                    break
                                self.wfile.write(chunk)
                                remaining -= len(chunk)
                        return
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with target.open("rb") as fh:
                    while True:
                        chunk = fh.read(64 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                return
            except FileNotFoundError:
                self._error(404, "文件不存在")
            except PermissionError as exc:
                self._error(403, str(exc))
            except (ValueError, OSError) as exc:
                self._error(400, str(exc))
            return
        if path == "/api/knowledge/media-thumb":
            # Extract a preview frame from a vault video (ffmpeg) and cache it.
            try:
                relative = urllib.parse.parse_qs(parsed.query).get("path", [""])[0]
                target = self._safe_vault_path(relative)
                if not target.is_file() or target.suffix.lower() not in self.MEDIA_EXTS:
                    raise PermissionError("只允许访问视频文件")
                thumb_dir = self.config.product_state / "thumbnails"
                thumb_dir.mkdir(parents=True, exist_ok=True)
                thumb = thumb_dir / f"{hashlib.sha256(str(target).encode('utf-8')).hexdigest()[:20]}.jpg"
                if not thumb.exists() or thumb.stat().st_mtime < target.stat().st_mtime:
                    ffmpeg = self.config.ffmpeg_path
                    if not ffmpeg:
                        raise ValueError("未找到 ffmpeg，无法生成缩略图")
                    command = [
                        str(ffmpeg), "-y", "-ss", "1", "-i", str(target),
                        "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", str(thumb),
                    ]
                    subprocess.run(command, capture_output=True, timeout=60, check=True)
                if not thumb.exists():
                    raise ValueError("缩略图生成失败")
                data = thumb.read_bytes()
                self._headers(200, "image/jpeg", len(data))
                self.wfile.write(data)
                return
            except FileNotFoundError:
                self._error(404, "文件不存在")
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                self._error(502, "缩略图生成失败")
            except PermissionError as exc:
                self._error(403, str(exc))
            except (ValueError, OSError) as exc:
                self._error(400, str(exc))
            return
        if path == "/api/knowledge/heartbeat":
            self._json({"service": "boujoy-knowledge", "ready": True, "vaultRoot": str(self.config.vault)})
            return
        if path == "/api/session/deleted":
            self._json({"ok": True, "sessionIds": sorted(self._deleted_session_ids())})
            return
        if path == "/api/records":
            kind = urllib.parse.parse_qs(parsed.query).get("kind", ["expert"])[0]
            try:
                self._json({"ok": True, "records": self._list_records(kind)})
            except ValueError as exc:
                self._error(400, str(exc))
            return
        match = re.fullmatch(r"/api/harness/(knowledge|clean)/(events\.mux|events\.host)", path)
        if match:
            mode, endpoint = match.groups()
            # WebSocket upgrade from the product page: terminate here (same-origin)
            # and relay frames to Harness without an Origin header. The access
            # code rides in the query string (browsers cannot set WS headers).
            if str(self.headers.get("Upgrade", "")).lower() == "websocket":
                origin = self.headers.get("Origin", "")
                if origin and not self._request_origin_allowed(origin):
                    self._error(403, "cross-origin websocket blocked")
                    return
                if not self._require_access(parsed):
                    self._deny_access()
                    return
                self._ws_upgrade(mode, f"/api/{endpoint}")
                return
            self._proxy(f"{HARNESS_ORIGINS[mode]}/api/{endpoint}", stream=True)
            return
        self._serve_static(path)

    def _ws_upgrade(self, mode: str, path: str) -> None:
        """Answer the browser's WebSocket upgrade, then bridge to Harness."""
        key = self.headers.get("Sec-WebSocket-Key", "")
        try:
            upstream = socket.create_connection(("127.0.0.1", 3080 if mode == "knowledge" else 3081), timeout=10)
        except OSError:
            self._error(502, "Harness 事件流未就绪")
            return
        initial_upstream_bytes = _ws_handshake(upstream, path, "127.0.0.1:3080" if mode == "knowledge" else "127.0.0.1:3081")
        if initial_upstream_bytes is None:
            try:
                upstream.close()
            except OSError:
                pass
            self._error(502, "Harness WebSocket 握手失败")
            return
        # Complete the browser-side handshake.
        accept = _ws_accept_key(key)
        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
            "\r\n"
        )
        try:
            self.connection.sendall(response.encode("ascii"))
            if initial_upstream_bytes:
                self.connection.sendall(initial_upstream_bytes)
        except OSError:
            try:
                upstream.close()
            except OSError:
                pass
            return
        # From here on the raw socket is the WebSocket; relay both directions.
        self.close_connection = True
        _ws_relay(self.connection, upstream)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        if not self._require_access(parsed):
            self._deny_access()
            return
        size = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(size) if size else b""
        # Every POST can mutate state: the generic Harness proxy carries
        # session.prompt/cancel/permissions just as well as list/history calls.
        # Validate browser Origin globally, while still allowing no-Origin local
        # tools (curl) and the phone page's exact same-origin private-IP URL.
        origin = self.headers.get("Origin", "")
        if origin and not self._request_origin_allowed(origin):
            self._error(403, "cross-origin write blocked")
            return
        if path == "/api/app/restart":
            # Agent-safe restart path. The Harness cannot reliably quit and
            # reopen its own parent process from a shell tool: that tears down
            # the command before its relaunch helper is guaranteed to survive.
            # Instead, acknowledge the request first, then ask the native app
            # (our direct parent) to run its detached relaunch sequence.
            client_host = str(self.client_address[0])
            if client_host not in {"127.0.0.1", "::1"}:
                self._error(403, "restart is loopback-only")
                return
            if self.config.restart_file is not None:
                try:
                    self.config.request_managed_restart()
                except OSError as exc:
                    self._error(503, f"Windows restart host is unavailable: {exc}")
                    return
                self._json({"ok": True, "restarting": True, "managed": True, "serverPid": os.getpid()})
                return
            if os.name == "nt":
                # A browser-only launch has no native parent that can receive
                # SIGUSR1. The Windows launcher always supplies a managed
                # restart file, so fail clearly instead of reporting success
                # and leaving the page on an old process.
                self._error(503, "Windows restart host is not configured")
                return
            parent_pid = os.getppid()
            if parent_pid <= 1:
                self._error(503, "native app parent is unavailable")
                return

            def request_restart() -> None:
                # Give the HTTP response and any invoking Agent tool enough
                # time to flush before the native parent tears services down.
                time.sleep(0.8)
                try:
                    os.kill(parent_pid, signal.SIGUSR1)
                except OSError:
                    pass

            threading.Thread(target=request_restart, name="boujoy-restart", daemon=True).start()
            self._json({"ok": True, "restarting": True})
            return
        match = re.fullmatch(r"/api/harness/(knowledge|clean)/(.+)", path)
        if match:
            mode, endpoint = match.groups()
            self._proxy(
                f"{HARNESS_ORIGINS[mode]}/api/{endpoint}",
                method="POST",
                body=body,
                filter_deleted=endpoint in {"session.list", "session.search", "workspace.list"},
            )
            return
        if path == "/api/session/delete":
            try:
                payload = json.loads(body or b"{}")
                session_id = str(payload.get("sessionId", ""))
                mode = str(payload.get("mode", "knowledge"))
                if mode not in {"knowledge", "clean"}:
                    raise ValueError("无效运行模式")
                moved = self._trash_session_logs(session_id, mode)
                self._json({"ok": True, "sessionId": session_id, "movedLogs": moved, "recoverable": True})
            except FileNotFoundError:
                self._error(404, "Harness 会话目录不存在")
            except (ValueError, json.JSONDecodeError, OSError, PermissionError) as exc:
                self._error(400 if not isinstance(exc, PermissionError) else 403, str(exc))
            return
        if path == "/api/knowledge/reveal":
            try:
                payload = json.loads(body or b"{}")
                target = self._safe_vault_path(str(payload.get("path", "")))
                if os.name == "nt":
                    subprocess.Popen(["explorer.exe", "/select,", str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    subprocess.Popen(["/usr/bin/open", "-R", str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self._json({"ok": True, "revealed": str(payload.get("path", ""))})
            except (ValueError, json.JSONDecodeError, OSError, PermissionError) as exc:
                self._error(400, str(exc))
            return
        if path == "/api/knowledge/delete-card":
            try:
                payload = json.loads(body or b"{}")
                relative = str(payload.get("path", "")).replace("\\", "/")
                if self._protected_markdown(relative):
                    raise PermissionError("系统、索引、UI 和 Skills 文件受保护")
                target = self._safe_vault_path(relative, require_markdown=True, reject_symlinks=True)
                self._move_to_trash([target])
                self._json({"ok": True, "deleted": relative})
            except FileNotFoundError:
                self._error(404, "文件不存在")
            except (ValueError, json.JSONDecodeError, OSError, PermissionError) as exc:
                self._error(400 if not isinstance(exc, PermissionError) else 403, str(exc))
            return
        if path == "/api/knowledge/cleanup":
            try:
                payload = json.loads(body or b"{}")
                requested = [str(item).replace("\\", "/") for item in payload.get("paths", [])]
                allowed = self._cleanup_candidates()
                if any(item not in allowed for item in requested):
                    raise PermissionError("只能清理扫描报告中的候选文件")
                targets = []
                for relative in dict.fromkeys(requested):
                    if self._protected_markdown(relative):
                        raise PermissionError("系统、索引、UI 和 Skills 文件受保护")
                    targets.append(self._safe_vault_path(relative, require_markdown=True, reject_symlinks=True))
                self._move_to_trash(targets)
                self._json({"ok": True, "moved": len(targets)})
            except (ValueError, json.JSONDecodeError, OSError, PermissionError) as exc:
                self._error(400 if not isinstance(exc, PermissionError) else 403, str(exc))
            return
        if path == "/api/knowledge/capture":
            try:
                payload = json.loads(body or b"{}")
                result = self._capture_write(payload)
                self._json(result)
            except (ValueError, json.JSONDecodeError, OSError, PermissionError) as exc:
                self._error(400 if not isinstance(exc, PermissionError) else 403, str(exc))
            return
        if path == "/api/records/save":
            try:
                payload = json.loads(body or b"{}")
                item = self._save_record(str(payload.get("kind", "expert")), payload)
                self._json({"ok": True, "record": item})
            except (ValueError, json.JSONDecodeError, OSError) as exc:
                self._error(400, str(exc))
            return
        if path == "/api/records/delete":
            try:
                payload = json.loads(body or b"{}")
                self._delete_record(str(payload.get("kind", "expert")), str(payload.get("id", "")))
                self._json({"ok": True})
            except (ValueError, json.JSONDecodeError, OSError) as exc:
                self._error(400, str(exc))
            return
        self._error(404, "not found")


class BoujoyServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Browsers routinely close superseded fetch/WebSocket connections
        # during reload, mode changes and app restart. They are not server
        # faults and must not flood the persistent service log with tracebacks.
        error = sys.exc_info()[1]
        if isinstance(error, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)

    def server_bind(self) -> None:
        # Base HTTPServer.server_bind calls socket.getfqdn(host) for the
        # server_name, which does a reverse-DNS lookup that stalls ~5s when
        # binding 0.0.0.0 on machines without a resolvable hostname. Skip it:
        # bind the socket directly and only grab the numeric address.
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port

    def __init__(self, address: tuple[str, int], config: AppConfig):
        super().__init__(address, BoujoyHandler)
        self.config = config
        self.vault_cache: dict[tuple[tuple[int, int, str, str], ...], list[dict[str, Any]]] = {}
        self.access_attempt_lock = threading.Lock()
        self.access_attempts: dict[str, list[float]] = {}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--static", required=True)
    parser.add_argument("--knowledge-home")
    parser.add_argument("--clean-home")
    parser.add_argument("--access-code", default="", help="PIN for phone/remote access; empty disables remote access")
    parser.add_argument("--restart-file", help="managed-host restart signal file (used by the Windows launcher)")
    args = parser.parse_args()
    config = AppConfig(
        Path(args.vault),
        Path(args.static),
        Path(args.knowledge_home) if args.knowledge_home else None,
        Path(args.clean_home) if args.clean_home else None,
    )
    config.access_code = args.access_code
    config.restart_file = Path(args.restart_file).resolve() if args.restart_file else None
    # A desktop launch always supplies a code before exposing the phone view.
    # A manually launched server without one must stay local: otherwise a
    # nearby LAN client could read the vault and drive the Harness unauthenticated.
    bind_host = "0.0.0.0" if config.access_code else LOOPBACK
    server = BoujoyServer((bind_host, args.port), config)
    native_parent_pid = os.getppid()

    def stop_with_native_parent() -> None:
        # A force-quit/crash does not run AppKit's applicationWillTerminate.
        # Do not leave an orphan gateway occupying 8766 and impersonating the
        # next App launch; shut down as soon as our original parent disappears.
        if native_parent_pid <= 1:
            return
        while os.getppid() == native_parent_pid:
            time.sleep(0.5)
        server.shutdown()

    threading.Thread(target=stop_with_native_parent, name="boujoy-parent-watch", daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
