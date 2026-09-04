"""LaTeX → PDF compilation of exported tables (pdflatex in a temporary directory).

Used by ``POST /api/pdf`` (see ``ontoviewer.http``): the browser sends the LaTeX table it
generated for an axiom/metrics export and receives the compiled PDF as a download.
Single entry point: ``compile_pdf(tex)``.
"""

import pathlib
import shutil
import subprocess
import tempfile


def compile_pdf(tex):
    """Wrap a LaTeX fragment (table) in a standalone document, compile it with pdflatex in a
    temporary directory, return (pdf bytes, None) or (None, error log).

    ``pdflatex`` is looked up on PATH, then at the MacTeX location.  The fragment is inserted
    in an ``article`` document with the packages the exporters use (tabularx, booktabs,
    longtable, amsmath…); ``[htbp]`` table placement is relaxed to ``[h]`` since the document
    contains nothing else.  Compilation runs with a 120 s timeout; the temporary directory is
    removed on success and on compilation failure.  The error string contains the ``!`` lines
    of the LaTeX log (at most 5) or, failing that, the log tail.
    """
    Path = pathlib.Path
    exe = shutil.which("pdflatex") or "/Library/TeX/texbin/pdflatex"
    if not Path(exe).exists():
        return None, "pdflatex not found (install MacTeX/TeX Live)"
    doc = (
        "\\documentclass[a4paper,11pt]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n"
        "\\usepackage[margin=2cm]{geometry}\n\\usepackage{tabularx,booktabs,longtable,array,amsmath,amssymb,url}\n"
        "\\urlstyle{same}\n\\usepackage[english]{babel}\n"
        "\\pagestyle{empty}\n\\begin{document}\n"
        + tex.replace("\\begin{table}[htbp]", "\\begin{table}[h]")
        + "\n\\end{document}\n"
    )
    tmp = Path(tempfile.mkdtemp(prefix="sdf_pdf_"))
    (tmp / "export.tex").write_text(doc, encoding="utf-8")
    try:
        # nonstopmode + halt-on-error: never wait for keyboard input, stop at the first error
        r = subprocess.run(
            [exe, "-interaction=nonstopmode", "-halt-on-error", "export.tex"],
            cwd=tmp,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        shutil.rmtree(tmp, ignore_errors=True)
        return None, "pdflatex: timeout"
    pdf = tmp / "export.pdf"
    if r.returncode != 0 or not pdf.exists():
        # LaTeX reports errors as lines starting with "!" in the .log file
        log = (tmp / "export.log").read_text(errors="replace") if (tmp / "export.log").exists() else r.stdout
        err = [line for line in log.splitlines() if line.startswith("!")]
        shutil.rmtree(tmp, ignore_errors=True)
        return None, "pdflatex failed: " + (" | ".join(err[:5]) or log[-800:])
    data = pdf.read_bytes()
    shutil.rmtree(tmp, ignore_errors=True)
    return data, None
