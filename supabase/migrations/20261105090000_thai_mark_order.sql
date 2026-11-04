-- =====================================================================
-- Phase 2C.1 / step 1 — Thai typed answers match whatever order the marks
-- were typed in
--
-- Thai stacks marks on a consonant (vowels above/below, tone marks, ํ, ์).
-- Keyboards let people type them in any order and the screen often looks
-- the same, e.g. "ที่" typed ท ่ ี or ท ี ่, "กุ้ง" typed ก ้ ุ ง. Unicode
-- does not reorder Thai marks, so these used to compare as different.
--
-- private.thai_mark_order puts every run of marks in one fixed order:
--   below vowel (ุ ู ฺ) → above vowel (ั ิ ี ึ ื ็) → tone (่ ้ ๊ ๋) → ํ ์ ๎
-- keeping the typed order inside each group, and drops a mark typed twice
-- in the same run. "ำ" typed before the tone ("นำ้") is moved too.
-- Still no fuzzy spelling: different marks stay different (owner decision).
-- Keys are stored as typed; both sides are normalised when compared, so no
-- data changes.
-- =====================================================================

create function private.thai_mark_order(p text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out text := '';
  v_run text[] := '{}';
  v_c text;
begin
  -- "ํา" then a tone ("นำ้" = น ํ า ้): the tone belongs on the consonant
  p := regexp_replace(coalesce(p, ''), 'ํา([่-๋])', '\1' || chr(x'0E4D'::int) || chr(x'0E32'::int), 'g');
  foreach v_c in array regexp_split_to_array(p, '') || array[''] loop
    if v_c ~ '^[ัิ-ฺ็-๎]$' then
      v_run := v_run || v_c;
    else
      if cardinality(v_run) > 0 then
        v_out := v_out || (
          select string_agg(m.c, '' order by m.grp, m.first_at)
            from (select r.c, min(r.i) as first_at,
                         case when r.c ~ '[ุ-ฺ]' then 1
                              when r.c ~ '[ัิ-ื็]' then 2
                              when r.c ~ '[่-๋]' then 3
                              else 4 end as grp
                    from unnest(v_run) with ordinality r(c, i)
                   group by r.c) m);
        v_run := '{}';
      end if;
      v_out := v_out || v_c;
    end if;
  end loop;
  return v_out;
end;
$$;

create or replace function private.normalize_answer(p text)
returns text
language sql immutable
set search_path = ''
as $$
  select lower(btrim(regexp_replace(
           translate(
             private.thai_mark_order(
               regexp_replace(normalize(coalesce(p, ''), NFKC), '[​‌‍⁠﻿­]', '', 'g')),
             '๐๑๒๓๔๕๖๗๘๙', '0123456789'),
           '\s+', ' ', 'g')))
$$;

revoke all on function private.thai_mark_order(text) from public;
revoke all on function private.normalize_answer(text) from public;

comment on function private.thai_mark_order(text) is 'เรียงสระบน/ล่าง วรรณยุกต์ ํ ์ ของแต่ละพยัญชนะเป็นลำดับเดียว + ตัดตัวที่พิมพ์ซ้ำ (เทียบคำตอบเติมคำ)';
comment on function private.normalize_answer(text) is 'เทียบคำตอบเติมคำ: NFKC, ตัดอักขระที่มองไม่เห็น, ลำดับสระ/วรรณยุกต์ไทย, เลขไทย → 0-9, ยุบช่องว่าง, ตัวพิมพ์เล็ก — ไม่ตรวจคำสะกดใกล้เคียง';
