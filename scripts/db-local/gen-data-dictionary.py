#!/usr/bin/env python3
"""Generate docs/DATA_DICTIONARY.md from a LOCAL database built by reset.sh.
Usage: python3 scripts/db-local/gen-data-dictionary.py [dbname] > docs/DATA_DICTIONARY.md
Without a local psql, point PSQL at the Supabase Local container, e.g.
  PSQL="docker exec -i supabase_db_<project> psql -U postgres -d postgres" python3 scripts/db-local/gen-data-dictionary.py"""
import json, os, shlex, subprocess, sys

db = sys.argv[1] if len(sys.argv) > 1 else "solveedu_local"
SQL = r"""
select json_agg(t order by t.ord) from (
  select c.relname as table, obj_description(c.oid) as comment, c.oid::int as ord,
    (select json_agg(json_build_object(
        'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
        'nn', a.attnotnull, 'def', pg_get_expr(d.adbin, d.adrelid),
        'comment', col_description(c.oid, a.attnum)) order by a.attnum)
       from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as cols,
    (select json_agg(json_build_object('name', conname, 'def', pg_get_constraintdef(oid)) order by contype, conname)
       from pg_constraint where conrelid = c.oid) as cons,
    (select json_agg(indexdef order by indexname) from pg_indexes
      where schemaname = 'public' and tablename = c.relname
        and indexname not in (select conname from pg_constraint where conrelid = c.oid)) as idx
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
) t;
"""
psql = shlex.split(os.environ["PSQL"]) if os.environ.get("PSQL") else ["psql", "-d", db]
out = subprocess.run([*psql, "-X", "-At", "-c", SQL], capture_output=True, text=True, check=True).stdout
tables = json.loads(out)
esc = lambda s: (s or "").replace("|", "\\|").replace("\n", " ")
print("# Data Dictionary — SolveEdu Platform (Phase 3)\n")
print(f"> สร้างอัตโนมัติจากฐานข้อมูล Local ด้วย `scripts/db-local/gen-data-dictionary.py` — อย่าแก้ไขด้วยมือ  ")
print("> ทุกตารางใน `public` เปิด RLS; สิทธิ์รายคอลัมน์ดู `PERMISSIONS.md`\n")
print("## สารบัญ\n")
for t in tables:
    print(f"- [`{t['table']}`](#{t['table'].replace('_','-')}) — {esc(t['comment'])}")
for t in tables:
    print(f"\n## {t['table']}\n\n{esc(t['comment'])}\n")
    print("| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |\n|---|---|:-:|---|---|")
    for c in t["cols"]:
        print(f"| `{c['name']}` | {esc(c['type'])} | {'✓' if c['nn'] else ''} | {('`'+esc(c['def'])+'`') if c['def'] else ''} | {esc(c['comment'])} |")
    if t["cons"]:
        print("\n**Constraints**\n")
        for k in t["cons"]:
            print(f"- `{k['name']}`: `{esc(k['def'])}`")
    if t["idx"]:
        print("\n**Indexes**\n")
        for i in t["idx"]:
            print(f"- `{esc(i)}`")
