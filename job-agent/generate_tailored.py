#!/usr/bin/env python3
"""Generate per-job tailored resume .tex files from the canonical main.tex.

Reads tailor_config.json: {"jobs":[{"outfile","summary","sap_line",
"accenture_bullet_order"}]}. Only the Professional Summary paragraph, the
SAP Technologies skills line, and the order of Accenture \resumeItem bullets
are changed — never the preamble, subheadings, certifications, or education.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MASTER = os.path.join(HERE, "main.tex")
OUTDIR = os.path.join(HERE, "resumes")


def tailor(src, job):
    # 1. Replace the summary paragraph (between \section{Professional Summary}
    #    and the next %----- comment).
    out = re.sub(
        r"(\\section\{Professional Summary\}\n).*?(\n\n%-)",
        lambda m: m.group(1) + job["summary"].strip() + m.group(2),
        src, flags=re.S)

    # 2. Replace the SAP Technologies line.
    if job.get("sap_line"):
        out = re.sub(
            r"\\textbf\{SAP Technologies:\}[^\\]*\\\\",
            lambda m: "\\textbf{SAP Technologies:} " + job["sap_line"].strip()
                      + " \\\\", out)

    # 3. Reorder Accenture bullets.
    order = job.get("accenture_bullet_order")
    if order:
        acc = re.search(
            r"(\{Accenture\}.*?\\resumeItemListStart\n)(.*?)(\s*\\resumeItemListEnd)",
            out, flags=re.S)
        bullets = re.findall(r"\\resumeItem\{.*?\}(?:\n|$)", acc.group(2),
                             flags=re.S)
        assert len(bullets) == len(order), "bullet count mismatch"
        new = "".join("        " + bullets[i].strip() + "\n" for i in order)
        out = out[:acc.start(2)] + new + out[acc.end(2):]
    return out


def main():
    cfg = json.load(open(os.path.join(HERE, sys.argv[1] if len(sys.argv) > 1
                                      else "tailor_config.json")))
    os.makedirs(OUTDIR, exist_ok=True)
    src = open(MASTER).read()
    for job in cfg["jobs"]:
        path = os.path.join(OUTDIR, job["outfile"])
        open(path, "w").write(tailor(src, job))
        ok = True
        for _ in range(2):
            r = subprocess.run(["pdflatex", "-interaction=nonstopmode",
                                os.path.basename(path)],
                               cwd=OUTDIR, capture_output=True, text=True)
            ok = ok and ("Output written" in r.stdout)
        pages = re.search(r"Output written on .*\((\d+) page", r.stdout)
        print(job["outfile"], "OK" if ok else "COMPILE-FAILED",
              f"pages={pages.group(1) if pages else '?'}")


if __name__ == "__main__":
    main()
