-- =====================================================================
-- Phase 2D / step 1 — import items into a draft from a file (owner decisions)
--
-- import_instrument_items(version, items) appends a batch of items, each
-- with its answer key, to a DRAFT version. All or nothing: one call is one
-- transaction, so any bad row leaves the version unchanged; the error says
-- which row (DETAIL "แถวที่ n", n = position in the array, from 1).
--
-- SECURITY INVOKER on purpose: every row goes through the same gates as
-- typing it into the builder — the items RLS policy (can_manage_version),
-- the draft-only/shape trigger, and set_item_key (key checks + audit that
-- never stores the key). Nothing here can do more than the caller can.
--
--   items: [{item_type, prompt, max_score?, options_json, scoring_mode?, answer}]
--   types: mcq_single, mcq_multiple, true_false, numeric (the newer types
--          later); every row needs its answer, so the version can be
--          published straight after; at most 200 rows per call.
-- =====================================================================

create function public.import_instrument_items(p_version uuid, p_items jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_max constant integer := 200;
  v_row jsonb;
  v_n integer := 0;
  v_order integer;
  v_item uuid;
  v_state text;
  v_msg text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if not authz.can_manage_version(p_version) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.instrument_versions v where v.id = p_version and v.status = 'draft') then
    raise exception 'only a draft version takes an import (create a new version first)' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'items must be a non-empty array' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_array_length(p_items) > v_max then
    raise exception 'at most % items per import', v_max using errcode = 'invalid_parameter_value';
  end if;

  select coalesce(max(i.display_order), 0) into v_order
    from public.instrument_items i where i.instrument_version_id = p_version;

  for v_row in select e from jsonb_array_elements(p_items) e loop
    v_n := v_n + 1;
    begin
      if jsonb_typeof(v_row) is distinct from 'object'
         or exists (select 1 from jsonb_object_keys(v_row) k
                     where k not in ('item_type', 'prompt', 'max_score', 'options_json', 'scoring_mode', 'answer')) then
        raise exception 'row must be {item_type, prompt, max_score, options_json, scoring_mode, answer}'
          using errcode = 'invalid_parameter_value';
      end if;
      if (v_row ->> 'item_type') is null
         or (v_row ->> 'item_type') not in ('mcq_single', 'mcq_multiple', 'true_false', 'numeric') then
        raise exception 'item type % cannot be imported', coalesce(v_row ->> 'item_type', 'null')
          using errcode = 'invalid_parameter_value';
      end if;
      if jsonb_typeof(v_row -> 'answer') is distinct from 'object' then
        raise exception 'every imported item needs its answer' using errcode = 'invalid_parameter_value';
      end if;

      v_order := v_order + 1;
      insert into public.instrument_items
        (instrument_version_id, item_type, prompt, media_path, options_json, max_score, display_order, scoring_mode)
      values (p_version, v_row ->> 'item_type', v_row ->> 'prompt', null,
              coalesce(v_row -> 'options_json', '{}'::jsonb),
              coalesce((v_row ->> 'max_score')::numeric, 1), v_order, v_row ->> 'scoring_mode')
      returning id into v_item;
      perform public.set_item_key(v_item, v_row -> 'answer');
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      raise exception '%', v_msg using errcode = v_state, detail = format('แถวที่ %s', v_n);
    end;
  end loop;
  return v_n;
end;
$$;

revoke execute on function public.import_instrument_items(uuid, jsonb) from public, anon;
grant execute on function public.import_instrument_items(uuid, jsonb) to authenticated;

comment on function public.import_instrument_items(uuid, jsonb) is
  'นำเข้าข้อสอบ (4 แบบพื้นฐาน) พร้อมเฉลยต่อท้ายฉบับร่าง ทั้งหมดหรือไม่เลย · สิทธิ์ของผู้เรียก (RLS + trigger + set_item_key เดิม) · แถวผิด → DETAIL "แถวที่ n" · ไม่เกิน 200 แถว';
