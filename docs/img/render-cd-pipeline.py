#!/usr/bin/env python3
"""Place docs/img/cd-pipeline.mmd on a grid and write docs/img/cd-pipeline.svg.

mermaid-cli's layered layout puts each failure node on the next row and drifts
the spine, so connectors sweep across the picture. This keeps the graph in the
mermaid file (labels, classes, colours, and which node fails to which) and
draws one row per stage: the happy path on the left, the failure on the right.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
MMD = ROOT / "cd-pipeline.mmd"
SVG = ROOT / "cd-pipeline.svg"

NODE = re.compile(r'(\w+)\["([^"]+)"\]:::(\w+)')
CLASS = re.compile(r"classDef\s+(\w+)\s+fill:(#[0-9a-fA-F]{6}),stroke:(#[0-9a-fA-F]{6})")
EDGE = r'(\w+)(?:\["[^"]*"\])?(?:::\w+)?\s+{arrow}\s+(\w+)'
HAPPY = re.compile(EDGE.format(arrow="==>"))
SIDE = re.compile(EDGE.format(arrow="-->"))

LEFT_X, LEFT_W, BOX_H = 40, 340, 72
RIGHT_X, RIGHT_W = 476, 344
ROW0, ROW_STEP = 84, 112
WIDTH = 860


def esc(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def split_label(label: str) -> tuple[str, str]:
    kind, _, detail = label.partition(" · ")
    return kind.strip(), detail.strip()


def main() -> int:
    text = MMD.read_text()
    nodes = {m.group(1): (m.group(2), m.group(3)) for m in NODE.finditer(text)}
    colors = {m.group(1): (m.group(2), m.group(3)) for m in CLASS.finditer(text)}
    code = "\n".join(line for line in text.splitlines() if not line.strip().startswith("%%"))
    bare = re.sub(r'(\w+)\["[^"]*"\]:::\w+', r"\1", code)
    happy = {src: dst for src, dst in HAPPY.findall(bare)}
    side = {src: dst for src, dst in SIDE.findall(bare)}
    targets = set(happy.values())
    start = [node for node in happy if node not in targets]
    if len(start) != 1:
        sys.exit(f"expected one start node, found {start}")
    column = []
    node = start[0]
    while node:
        column.append(node)
        node = happy.get(node)
    if not column or column[-1] in happy:
        sys.exit("happy path did not end")

    rows = []
    for node in column:
        label, kind = nodes[node]
        fail = side.get(node)
        fail_box = None
        if fail:
            fail_label, fail_kind = nodes[fail]
            fail_box = (fail_label, fail_kind)
        rows.append((label, kind, fail_box))

    legend = []
    seen = set()
    for label, kind, _fail in rows:
        if kind in seen or kind in {"halt", "done"}:
            continue
        seen.add(kind)
        legend.append((split_label(label)[0], kind))
    if "rollback" in colors and "rollback" not in seen:
        legend.append(("Rollback", "rollback"))

    height = ROW0 + len(rows) * ROW_STEP + 150
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{height}" viewBox="0 0 {WIDTH} {height}" role="img" aria-labelledby="title desc">',
        '  <title id="title">ply-web operator deploy</title>',
        '  <desc id="desc">Happy path down the left column. Each failure is a short arrow to the right on that same row. Rendered from cd-pipeline.mmd.</desc>',
        f'  <rect width="{WIDTH}" height="{height}" fill="#ffffff"/>',
        "  <style>",
        "    text { font-family: ui-sans-serif, system-ui, sans-serif; fill: #0f172a; }",
        "    .kind { font-size: 16px; font-weight: 700; }",
        "    .detail { font-size: 14px; font-weight: 500; }",
        "    .legend { font-size: 13px; font-weight: 600; }",
        "  </style>",
        "  <defs>",
        '    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">',
        '      <path d="M 0 1.2 L 9 5 L 0 8.8 z" fill="#334155"/>',
        "    </marker>",
        "  </defs>",
        '  <text x="40" y="36" class="kind" font-size="18">ply-web operator deploy</text>',
        '  <text x="40" y="58" class="detail" fill="#475569">Left column moves forward. A failure leaves to the right and stops.</text>',
    ]

    def box(x: int, y: int, w: int, kind: str, label: str) -> None:
        fill, stroke = colors[kind]
        title, detail = split_label(label)
        cx = x + w / 2
        parts.append(
            f'  <rect x="{x}" y="{y}" width="{w}" height="{BOX_H}" rx="10" fill="{fill}" stroke="{stroke}" stroke-width="2"/>'
        )
        parts.append(f'  <text x="{cx}" y="{y + 28}" text-anchor="middle" class="kind">{esc(title)}</text>')
        if detail:
            parts.append(
                f'  <text x="{cx}" y="{y + 50}" text-anchor="middle" class="detail">{esc(detail)}</text>'
            )

    for index, (label, kind, fail) in enumerate(rows):
        y = ROW0 + index * ROW_STEP
        box(LEFT_X, y, LEFT_W, kind, label)
        if fail:
            fail_label, fail_kind = fail
            box(RIGHT_X, y, RIGHT_W, fail_kind, fail_label)
            mid = y + 36
            parts.append(
                f'  <line x1="{LEFT_X + LEFT_W}" y1="{mid}" x2="{RIGHT_X - 8}" y2="{mid}" stroke="#334155" stroke-width="1.75" marker-end="url(#arrow)"/>'
            )
        if index + 1 < len(rows):
            cx = LEFT_X + LEFT_W / 2
            parts.append(
                f'  <line x1="{cx}" y1="{y + BOX_H}" x2="{cx}" y2="{y + ROW_STEP - 8}" stroke="#334155" stroke-width="2.25" marker-end="url(#arrow)"/>'
            )

    legend_y = ROW0 + len(rows) * ROW_STEP + 24
    parts.append(f'  <text x="40" y="{legend_y}" class="detail" fill="#475569">Stage kind</text>')
    x = 40
    chip_y = legend_y + 14
    for title, kind in legend:
        fill, stroke = colors[kind]
        w = max(118, 16 + len(title) * 8)
        parts.append(
            f'  <rect x="{x}" y="{chip_y}" width="{w}" height="32" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="2"/>'
        )
        parts.append(
            f'  <text x="{x + w / 2}" y="{chip_y + 21}" text-anchor="middle" class="legend">{esc(title)}</text>'
        )
        x += w + 12
    caption_y = chip_y + 64
    parts.append(
        f'  <text x="40" y="{caption_y}" class="detail" fill="#475569">Gray boxes are a stop with traffic left as it is. Red boxes move the old version back to 100% and exit.</text>'
    )
    # The last text sits on the caption baseline. Keep a margin under it.
    height = caption_y + 28
    parts[1] = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{height}" viewBox="0 0 {WIDTH} {height}" role="img" aria-labelledby="title desc">'
    )
    parts.append("</svg>")
    SVG.write_text("\n".join(parts) + "\n")
    print(f"wrote {SVG} ({len(rows)} rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
