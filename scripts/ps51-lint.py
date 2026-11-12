#!/usr/bin/env python3
"""PowerShell 5.1 兼容性扫描器。

背景：沙箱里只有 PowerShell 7（Linux），而客户和我们自己的机器跑的是
Windows PowerShell 5.1。用 7 去解析只能证明"7 能跑"，证明不了"5.1 能跑"。
这个脚本反过来做：把 5.1 不支持的语法逐条找出来。

只做词法/字面层面能确定的检查，不复刻解析器。有疑问的一律报出来让人判断。
"""
import re
import sys
from pathlib import Path

# (规则名, 正则, 说明)
# 注意：全部在"去掉字符串字面量之后"的代码上匹配，避免误报。
RULES = [
    ("null-coalescing 运算符 ??",
     r"\?\?",
     "PS 7.0+。5.1 报「意外的标记 '??'」。用 if ($x) { $x } else { $y } 代替。"),

    ("null-conditional 运算符 ?.",
     r"\?\.",
     "PS 7.0+。5.1 不支持。改为先判空再取属性。"),

    # 已知局限：双引号插值 "$(... ? ... : ...)" 内的三元会被字符串抹白而漏检。
    ("三元运算符 ? :",
     r"(?<![?\w$.])\?(?![?.\w])[^:;\n]{0,120}:(?!:)",
     "PS 7.0+。5.1 不支持。用 if/else 赋值代替。"),

    ("管道链运算符 && / ||",
     r"(?<![&|])(?:&&|\|\|)(?![&|])",
     "PS 7.0+。5.1 不支持。改用 if 语句或分号。"),

    ("ForEach-Object -Parallel",
     r"-Parallel\b",
     "PS 7.0+。5.1 不支持。"),

    ("Get-Error",
     r"\bGet-Error\b",
     "PS 7.0+。5.1 不支持。"),

    ("Test-Json",
     r"\bTest-Json\b",
     "PS 6.0+。5.1 不支持。"),

    ("ConvertFrom-Json -AsHashtable",
     r"-AsHashtable\b",
     "PS 6.0+。5.1 不支持。"),

    ("Join-String",
     r"\bJoin-String\b",
     "PS 6.2+。5.1 不支持。"),

    ("ConvertTo-Json -AsArray",
     r"-AsArray\b",
     "PS 7.0+。5.1 不支持。"),

    ("ConciseView / -ConciseView",
     r"-ConciseView\b",
     "PS 7.0+。5.1 不支持。"),

    ("[ordered]@{} 之外的三元式类型转换",
     r"\[(?:type|System\.Type)\]\s*\[",
     "5.1 不支持。"),

    ("Invoke-RestMethod -SkipHttpErrorCheck",
     r"-SkipHttpErrorCheck\b",
     "PS 7.0+。5.1 不支持。"),

    ("Set-Content -NoNewline 之外：Set-Item -LiteralPath 的替代（-Encoding utf8NoBOM）",
     r"utf8NoBOM|utf8BOM\b|\butf8\b(?=\s*\))",
     "PS 6.0+ 的编码名。5.1 只认 UTF8/Unicode/ASCII/Default 等。"),
]

# 字符串字面量：单引号、双引号、here-string。替换成等长空白，保留行号。
def blank_literals(code: str) -> str:
    out = list(code)
    i, n = 0, len(code)
    while i < n:
        ch = code[i]
        # here-string 开始
        if code.startswith("@'", i) or code.startswith('@"', i):
            quote = code[i + 1]
            # 必须在本行结尾
            eol = code.find("\n", i)
            if eol == -1:
                break
            if code[i + 2:eol].strip() != "":
                # 不是 here-string，按普通引号处理
                pass
            else:
                end_marker = "\n" + quote + "@"
                end = code.find(end_marker, eol)
                if end == -1:
                    end = n
                else:
                    end += len(end_marker)
                for k in range(i, min(end, n)):
                    if out[k] != "\n":
                        out[k] = " "
                i = end
                continue
        if ch in "'\"":
            quote = ch
            j = i + 1
            while j < n:
                if code[j] == "`":          # 反引号转义
                    j += 2
                    continue
                if quote == "'" and code.startswith("''", j):
                    j += 2
                    continue
                if quote == '"' and code.startswith('""', j):
                    j += 2
                    continue
                if code[j] == quote:
                    j += 1
                    break
                if code[j] == "\n":
                    break
                j += 1
            for k in range(i, min(j, n)):
                if out[k] != "\n":
                    out[k] = " "
            i = j
            continue
        # 注释：整行 # 和行尾 # 都要吃掉，否则注释里的 ?? 会误报
        if ch == "#":
            eol = code.find("\n", i)
            if eol == -1:
                eol = n
            for k in range(i, eol):
                out[k] = " "
            i = eol
            continue
        i += 1
    return "".join(out)


def scan(path: Path):
    raw = path.read_bytes()
    has_bom = raw[:3] == b"\xef\xbb\xbf"
    crlf = raw.count(b"\r\n")
    bare_lf = raw.count(b"\n") - crlf
    text = raw.decode("utf-8-sig", errors="replace")
    stripped = blank_literals(text)

    findings = []
    for name, pattern, note in RULES:
        for m in re.finditer(pattern, stripped):
            line = stripped.count("\n", 0, m.start()) + 1
            col = m.start() - (stripped.rfind("\n", 0, m.start()) + 1) + 1
            findings.append((line, col, name, note, text.splitlines()[line - 1].strip()[:90]))

    print(f"=== {path.name} ===")
    print(f"  BOM: {has_bom} | CRLF: {crlf} | 裸LF: {bare_lf} | 行数: {len(text.splitlines())}")
    if not has_bom:
        print("  [!] 没有 UTF-8 BOM —— 5.1 会把中文当 GBK 读，可能乱码")
    if bare_lf:
        print(f"  [!] 有 {bare_lf} 个裸 LF —— 混合行尾，建议统一 CRLF")
    if findings:
        print(f"  [X] 发现 {len(findings)} 处 5.1 不兼容：")
        for line, col, name, note, snippet in findings:
            print(f"      行{line} 列{col}: {name}")
            print(f"        {note}")
            print(f"        代码: {snippet}")
    else:
        print("  [OK] 未发现 5.1 不兼容语法")
    print()
    return len(findings)


if __name__ == "__main__":
    targets = [Path(p) for p in sys.argv[1:]]
    if not targets:
        print("用法: ps51-lint.py <文件>...")
        sys.exit(2)
    total = 0
    for t in targets:
        if not t.exists():
            print(f"=== {t.name} ===  [缺失]\n")
            continue
        total += scan(t)
    print(f"合计 {total} 处需要处理。")
    sys.exit(1 if total else 0)
