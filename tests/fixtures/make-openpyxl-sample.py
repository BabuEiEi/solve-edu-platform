# Regenerates tests/fixtures/openpyxl-sample.xlsx (fictitious data) with an
# Excel writer that is not ours, for tests/unit/xlsx.test.js.
#   python3 -m venv /tmp/xl && /tmp/xl/bin/pip install openpyxl==3.1.5
#   /tmp/xl/bin/python tests/fixtures/make-openpyxl-sample.py tests/fixtures/openpyxl-sample.xlsx
import sys, datetime
from openpyxl import Workbook
from openpyxl.cell.rich_text import CellRichText, TextBlock
from openpyxl.cell.text import InlineFont

wb = Workbook()
ws = wb.active
ws.title = "รายชื่อ"
ws.append(["email", "full_name", "user_code", "score", "ok"])
ws.append(["teacher.one@example.test", "ครู ตัวอย่าง หนึ่ง", "00123", 12.5, True])
ws.append([])  # blank row, skipped by the reader
ws["A4"] = "teacher.two@example.test"
ws["B4"] = CellRichText(["ครู ", TextBlock(InlineFont(b=True), "ตัวหนา"), " สอง"])
ws["D4"] = "=1+1"  # formula, no cached value in openpyxl output
ws["E4"] = False
ws["C5"] = datetime.date(2026, 1, 2)
other = wb.create_sheet("อื่น")
other["A1"] = "not read"
wb.save(sys.argv[1])
