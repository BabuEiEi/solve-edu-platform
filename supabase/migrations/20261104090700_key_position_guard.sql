-- =====================================================================
-- Phase 2C / step 4 — the stored order must not give the answer away
--
-- A trainee who has started a test can read the items' options_json (that
-- is how the page shows them). For two types the stored order alone could
-- reveal the key:
--   ordering  options stored in the correct order
--   matching  right[i] is the partner of left[i] for every i
-- Such keys are now invalid: set_item_key refuses them and item_key_status
-- reports key_valid = false, so the version cannot be published. The quiz
-- builder stores these lists shuffled (with random ids) so authors never
-- meet this rule.
-- =====================================================================

alter function private.answer_key_error(text, jsonb, jsonb, jsonb) rename to answer_key_base_error;

create function private.answer_key_error(p_type text, p_options jsonb, p_answer jsonb, p_scoring jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    private.answer_key_base_error(p_type, p_options, p_answer, p_scoring),
    case
      when p_type = 'ordering'
           and array(select o.e ->> 'id' from jsonb_array_elements(p_options -> 'options') with ordinality o(e, i) order by o.i)
             = array(select k.v from jsonb_array_elements_text(p_answer -> 'order') with ordinality k(v, i) order by k.i)
        then 'the options are stored in the correct order (that would give the answer away); store them shuffled'
      when p_type = 'matching'
           and not exists (
             select 1
               from jsonb_array_elements(p_options -> 'left') with ordinality l(e, i)
               join jsonb_array_elements(p_options -> 'right') with ordinality r(e, i) on r.i = l.i
              where (p_answer -> 'slots' ->> (l.e ->> 'id')) is distinct from (r.e ->> 'id'))
        then 'every right entry is stored next to its partner (that would give the pairs away); store the right column shuffled'
    end)
$$;

revoke all on function private.answer_key_error(text, jsonb, jsonb, jsonb) from public;
revoke all on function private.answer_key_base_error(text, jsonb, jsonb, jsonb) from public;

comment on function private.answer_key_error(text, jsonb, jsonb, jsonb) is 'ตรวจเฉลย + ห้ามเก็บรายการในลำดับที่บอกเฉลย (เรียงลำดับ: ลำดับที่เก็บ = ลำดับที่ถูก; จับคู่: ทุกคู่อยู่ตำแหน่งเดียวกัน)';
