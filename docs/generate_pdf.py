#!/usr/bin/env python3
"""Convertit le guide Markdown en HTML autonome (ouvrable dans le navigateur, imprimable en PDF)."""
import markdown2

MD_FILE = "docs/Guide_Installation_PC_OmenServer.md"
HTML_FILE = "docs/Guide_Installation_PC_OmenServer.html"

with open(MD_FILE, "r") as f:
    md_content = f.read()

html_body = markdown2.markdown(md_content, extras=[
    "fenced-code-blocks", "tables", "header-ids", "code-friendly"
])

html = f"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Guide Installation PC — OmenServer</title>
<style>
    @media print {{
        body {{ font-size: 11px; }}
        pre {{ font-size: 10px; }}
        h1 {{ page-break-before: avoid; }}
        h2, h3 {{ page-break-after: avoid; }}
        pre, table, blockquote {{ page-break-inside: avoid; }}
    }}
    @page {{
        size: A4;
        margin: 2cm 2.5cm;
    }}
    * {{ box-sizing: border-box; }}
    body {{
        font-family: -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
        font-size: 14px;
        line-height: 1.7;
        color: #1a1a2e;
        background: #fff;
        max-width: 850px;
        margin: 0 auto;
        padding: 40px 30px;
    }}
    h1 {{
        font-size: 32px;
        color: #0f172a;
        border-bottom: 3px solid #10b981;
        padding-bottom: 12px;
        margin-top: 50px;
    }}
    h1:first-of-type {{
        font-size: 36px;
        text-align: center;
        border-bottom: 4px solid #10b981;
    }}
    h2 {{
        font-size: 22px;
        color: #1e293b;
        border-bottom: 2px solid #e2e8f0;
        padding-bottom: 6px;
        margin-top: 40px;
    }}
    h3 {{
        font-size: 17px;
        color: #334155;
        margin-top: 24px;
    }}
    h4 {{
        font-size: 15px;
        color: #475569;
    }}
    code {{
        background: #f1f5f9;
        padding: 2px 6px;
        border-radius: 4px;
        font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        font-size: 13px;
        color: #e11d48;
    }}
    pre {{
        background: #0f172a;
        color: #e2e8f0;
        padding: 18px 20px;
        border-radius: 10px;
        font-size: 12.5px;
        line-height: 1.6;
        overflow-x: auto;
        border: 1px solid #1e293b;
    }}
    pre code {{
        background: none;
        color: #e2e8f0;
        padding: 0;
        font-size: inherit;
    }}
    table {{
        width: 100%;
        border-collapse: collapse;
        margin: 18px 0;
        font-size: 13.5px;
    }}
    th {{
        background: #f8fafc;
        padding: 10px 14px;
        text-align: left;
        font-weight: 600;
        border-bottom: 2px solid #e2e8f0;
        color: #334155;
    }}
    td {{
        padding: 9px 14px;
        border-bottom: 1px solid #f1f5f9;
    }}
    tr:nth-child(even) td {{
        background: #fafafa;
    }}
    blockquote {{
        border-left: 4px solid #10b981;
        background: #f0fdf4;
        padding: 14px 18px;
        margin: 18px 0;
        border-radius: 0 10px 10px 0;
        font-size: 13px;
        color: #166534;
    }}
    blockquote p {{
        margin: 4px 0;
    }}
    hr {{
        border: none;
        border-top: 2px solid #e2e8f0;
        margin: 36px 0;
    }}
    ul, ol {{
        padding-left: 26px;
    }}
    li {{
        margin-bottom: 5px;
    }}
    a {{
        color: #2563eb;
        text-decoration: none;
    }}
    a:hover {{
        text-decoration: underline;
    }}
    strong {{
        color: #0f172a;
    }}
    /* Checklist style */
    li input[type="checkbox"] {{
        margin-right: 8px;
    }}
</style>
</head>
<body>
{html_body}
</body>
</html>"""

with open(HTML_FILE, "w") as f:
    f.write(html)

print(f"✅ HTML généré : {HTML_FILE}")
print(f"📄 Ouvre-le dans Chrome et fais Cmd+P pour imprimer en PDF")
