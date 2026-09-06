#!/usr/bin/env python3
"""Extract every titled palette command from src/**/*.ts*.

A palette command is an object literal carrying an `id` (string), `keys`
(array), and `title` (string); `group` is optional. Only titled commands are
listed (the palette hides untitled bindings like tab.goto1..9). The table is
sorted by group then id. Re-runnable; docs/FEATURES.md section 1 is this
script's output pasted verbatim.
"""

import os
import re
import sys

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")


def strip_strings(text):
    """Replace string, template, and comment spans with equal-length spaces so
    brace matching and keyword scans never read inside them."""
    out = list(text)
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        # line comment
        if ch == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            j = n if j == -1 else j
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        # block comment
        if ch == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            j = n if j == -1 else j + 2
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        # string or template literal
        if ch in ('"', "'", "`"):
            quote = ch
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == quote:
                    break
                j += 1
            if quote == "`":
                # a template can span braces; blank until the closing backtick
                j = text.find("`", i + 1)
                j = n if j == -1 else j + 1
            else:
                j = j + 1 if j < n else n
            # blank the inner content but keep the opening/closing quotes so
            # the structure (`id: "..."`) stays visible for the regexes.
            for k in range(i + 1, j - 1):
                out[k] = " "
            i = j
            continue
        i += 1
    return "".join(out)


def matched_brace(text, open_pos):
    """Return the index of the `}` matching the `{` at open_pos (0-based in the
    stripped text, where strings/comments are spaces)."""
    depth = 0
    i = open_pos
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


KEY_HINT = [
    (r"\$mod", "⌘"),
    (r"\bControl\b", "⌃"),
    (r"\bShift\b", "⇧"),
    (r"\bAlt\b", "⌥"),
    (r"\bMeta\b", "⌘"),
    (r"\bBracketRight\b", "]"),
    (r"\bBracketLeft\b", "["),
    (r"\bEqual\b", "="),
    (r"\bMinus\b", "-"),
    (r"Digit(\d)", r"\1"),
    (r"Key([A-Z])", r"\1"),
]


def format_keys(keys):
    out = []
    for k in keys:
        s = k.strip()
        for pat, repl in KEY_HINT:
            s = re.sub(pat, repl, s)
        s = s.replace("+", "")
        out.append(s)
    return ", ".join(out)


def iter_command_literals(source):
    """Yield (id, keys, title, group) for each titled command literal in a file."""
    stripped = strip_strings(source)
    for m in re.finditer(r'id\s*:\s*"([^"]+)"', stripped):
        id_pos = m.start()
        open_pos = stripped.rfind("{", 0, id_pos)
        if open_pos == -1:
            continue
        close_pos = matched_brace(stripped, open_pos)
        if close_pos == -1:
            continue
        # Positions are identical in source and stripped (same length), so read
        # the actual string values from the original source, not the blanked copy.
        id_val = source[m.start(1):m.end(1)]
        block = source[open_pos:close_pos + 1]
        keys_m = re.search(r"keys\s*:\s*\[([^\]]*)\]", block)
        title_m = re.search(r'title\s*:\s*"([^"]*)"', block)
        if not keys_m or not title_m:
            continue
        keys = re.findall(r'"([^"]*)"', keys_m.group(1))
        group_m = re.search(r'group\s*:\s*"([^"]*)"', block)
        group = group_m.group(1) if group_m else ""
        yield (id_val, keys, title_m.group(1), group)


def walk_files():
    for root, _dirs, files in os.walk(SRC):
        for name in files:
            if name.endswith((".ts", ".tsx")):
                yield os.path.join(root, name)


def rel(path):
    return os.path.relpath(path, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main():
    commands = []
    for path in walk_files():
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            source = fh.read()
        for cmd in iter_command_literals(source):
            commands.append((*cmd, rel(path)))
    commands.sort(key=lambda c: (c[3], c[0]))
    print("| group | title | keys | id | file |")
    print("| --- | --- | --- | --- | --- |")
    for cmd_id, keys, title, group, file in commands:
        print(f"| {group} | {title} | {format_keys(keys)} | {cmd_id} | {file} |")
    print(f"\n{len(commands)} palette commands.")


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
