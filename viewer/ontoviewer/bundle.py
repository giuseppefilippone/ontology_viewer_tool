"""Front-end build: format the readable sources and bundle + minify the JavaScript.

The page normally loads ``static/app.min.js`` — the eight sources of ``static/js/`` concatenated
in load order and minified with terser (one request, about a third of the bytes).  The readable
sources are what you edit and debug: opening the page with ``?dev=1`` serves them instead of the
bundle (see ``ontoviewer.http``).  ``build()`` runs at server start and rebuilds the bundle when
any source is newer than it.

``format_sources()`` formats the JavaScript and CSS with Prettier (project ``.prettierrc``) and
the Python of the whole ``code/`` tree with black, so hand-written and generated files share one
style.  Both tools are local dev dependencies (``npm install`` in code/viewer; black via pip).

CLI:  python3 -m ontoviewer.bundle [--format] [--force]
"""

import subprocess
import sys

from ontoviewer import config

JS_ORDER = ["core", "entities", "axioms", "graphs", "query", "reasoner", "inference", "main"]  # load order (main last)
JS_DIR = config.STATIC_DIR / "js"
BUNDLE = config.STATIC_DIR / "app.min.js"
NODE_BIN = config.VIEWER_DIR / "node_modules" / ".bin"
CODE_DIR = config.VIEWER_DIR.parent  # code/: pipeline scripts + viewer


def sources():
    """The readable JavaScript files in the order the browser must execute them."""
    return [JS_DIR / f"{name}.js" for name in JS_ORDER]


def script_tags(dev=False):
    """HTML <script> tags: the bundle, or the readable sources when ``dev`` is true."""
    if dev:
        return "\n".join(f'    <script src="/static/js/{name}.js"></script>' for name in JS_ORDER)
    return '    <script src="/static/app.min.js"></script>'


def stale():
    """True when the bundle is missing or older than one of its sources."""
    if not BUNDLE.exists():
        return True
    built = BUNDLE.stat().st_mtime
    return any(src.stat().st_mtime > built for src in sources())


def build(force=False):
    """Rebuild ``app.min.js`` with terser when stale (or ``force``); returns True when rebuilt.

    Top-level names are NOT mangled: the markup calls the functions by name from inline
    ``onclick`` handlers and the files share the global scope.
    """
    if not force and not stale():
        return False
    terser = NODE_BIN / "terser"
    if not terser.exists():
        raise FileNotFoundError("terser not installed: run `npm install` in code/viewer")
    subprocess.run(
        [str(terser), *map(str, sources()), "--compress", "--mangle", "--comments", "false", "-o", str(BUNDLE)],
        check=True,
        cwd=config.VIEWER_DIR,
    )
    return True


def format_sources():
    """Format JS/CSS with Prettier and every Python file under code/ with black (in place)."""
    prettier = NODE_BIN / "prettier"
    if not prettier.exists():
        raise FileNotFoundError("prettier not installed: run `npm install` in code/viewer")
    subprocess.run(
        [str(prettier), "--log-level", "warn", "--write", *map(str, sources()), str(config.STATIC_DIR / "app.css")],
        check=True,
        cwd=config.VIEWER_DIR,
    )
    py = [str(p) for p in CODE_DIR.glob("*.py")] + [str(p) for p in (config.VIEWER_DIR / "ontoviewer").rglob("*.py")]
    py.append(str(config.VIEWER_DIR / "server.py"))
    subprocess.run([sys.executable, "-m", "black", "-q", "-l", "120", *py], check=True)


if __name__ == "__main__":
    if "--format" in sys.argv:
        format_sources()
        print("formatted: JS/CSS (prettier), Python (black)")
    rebuilt = build(force="--force" in sys.argv)
    print(f"{BUNDLE.name}: {'rebuilt' if rebuilt else 'up to date'} ({BUNDLE.stat().st_size // 1024} KiB)")
