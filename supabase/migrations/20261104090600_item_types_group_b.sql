-- =====================================================================
-- Phase 2C / step 2 — item types, group B
--
--   dropdown        {text: "…{{b1}}…", blanks:[{id, options:[2-10 text entries]}] 1-20}
--                   key {"slots":{blank: option}} · response {"slots":{…}} (slot types)
--   cloze           {text: "…{{b1}}…", blanks:[{id, kind?: "text"|"number"}] 1-20}
--                   key {"blanks":{b1:{"accept":["…"]}, b2:{"value":n,"tolerance":t}}}
--                   response {"blanks":{b1:"typed text", b2: number}} — blanks may be left out
--   image_labelling media_path = the image (required) ·
--                   {markers:[{id, x, y} in % of the image] 1-15, labels:[2-20 text entries]}
--                   key {"slots":{marker: label}} · response {"slots":{…}}
--
-- Typed answers are compared after private.normalize_answer (owner decision):
-- NFKC (so "ำ" and "ํา" match), Thai tone mark typed before or after "ํ",
-- Thai digits → 0-9, invisible characters removed, spaces collapsed and
-- trimmed, case-insensitive. No fuzzy spelling. Partial credit is the default.
-- =====================================================================

alter table public.instrument_items drop constraint instrument_items_item_type_check;
alter table public.instrument_items add constraint instrument_items_item_type_check
  check (item_type in ('mcq_single', 'mcq_multiple', 'true_false', 'numeric',
                       'ordering', 'matching', 'classification', 'choice_matrix',
                       'dropdown', 'cloze', 'image_labelling'));
comment on column public.instrument_items.item_type is 'mcq_single|mcq_multiple|true_false|numeric (2B) · ordering|matching|classification|choice_matrix|dropdown|cloze|image_labelling (2C)';

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function private.normalize_answer(p text)
returns text
language sql immutable
set search_path = ''
as $$
  select lower(btrim(regexp_replace(
           translate(
             regexp_replace(
               regexp_replace(normalize(coalesce(p, ''), NFKC), '[​‌‍⁠﻿­]', '', 'g'),
               'ํ([่-๋])า', '\1' || chr(x'0E4D'::int) || chr(x'0E32'::int), 'g'),
             '๐๑๒๓๔๕๖๗๘๙', '0123456789'),
           '\s+', ' ', 'g')))
$$;

-- "…{{b1}}…{{b2}}…": every blank exactly once, nothing else in braces.
create or replace function private.template_error(p_text jsonb, p_ids text[])
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_text text;
  v_found text[];
begin
  if jsonb_typeof(p_text) is distinct from 'string' then
    return 'text must be a string';
  end if;
  v_text := p_text #>> '{}';
  if char_length(btrim(v_text)) = 0 or char_length(v_text) > 5000 then
    return 'text must be 1-5000 characters';
  end if;
  v_found := array(select m[1] from regexp_matches(v_text, '\{\{([a-z0-9]{1,8})\}\}', 'g') m);
  if (select count(*) from regexp_matches(v_text, '\{\{', 'g')) <> cardinality(v_found) then
    return 'malformed blank placeholder (use {{id}})';
  end if;
  if cardinality(v_found) <> (select count(distinct x) from unnest(v_found) x) then
    return 'each blank appears once in the text';
  end if;
  if not (v_found <@ p_ids and p_ids <@ v_found) then
    return 'blank placeholders in the text must match the blanks';
  end if;
  return null;
end;
$$;

create or replace function private.text_only_error(p_list jsonb, p_what text)
returns text language sql immutable set search_path = '' as $$
  select case when exists (select 1 from jsonb_array_elements(p_list) e where e ? 'image_path')
              then format('%s are text only', p_what) end
$$;

-- Slot types: each slot and the choice ids it accepts (dropdown: per blank).
create or replace function private.slot_choices(p_type text, p_options jsonb)
returns table (slot_id text, choice_ids text[])
language sql immutable
set search_path = ''
as $$
  select s ->> 'id',
         private.ids_of(p_options -> case p_type when 'matching' then 'right'
                                                 when 'classification' then 'categories'
                                                 when 'choice_matrix' then 'columns'
                                                 when 'image_labelling' then 'labels' end)
    from jsonb_array_elements(coalesce(p_options -> case p_type when 'matching' then 'left'
                                                                when 'classification' then 'items'
                                                                when 'choice_matrix' then 'rows'
                                                                when 'image_labelling' then 'markers' end,
                                       '[]'::jsonb)) s
   where p_type in ('matching', 'classification', 'choice_matrix', 'image_labelling')
  union all
  select b ->> 'id', private.ids_of(b -> 'options')
    from jsonb_array_elements(coalesce(p_options -> 'blanks', '[]'::jsonb)) b
   where p_type = 'dropdown'
$$;

-- ---------------------------------------------------------------------
-- Shapes
-- ---------------------------------------------------------------------
create or replace function private.item_shape_error(p_type text, p_options jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keys text[];
  v jsonb;
  v_ids text[] := '{}';
  v_err text;
begin
  if jsonb_typeof(p_options) is distinct from 'object' then
    return 'options_json must be an object';
  end if;
  select coalesce(array_agg(k order by k), '{}') into v_keys from jsonb_object_keys(p_options) k;

  case p_type
    when 'mcq_single', 'mcq_multiple', 'ordering' then
      if v_keys <> array['options'] then
        return 'options_json must contain exactly "options"';
      end if;
      return private.entries_error(p_options -> 'options', case when p_type = 'ordering' then 3 else 2 end, 10, 'options');
    when 'matching' then
      if v_keys <> array['left', 'right'] then
        return 'options_json must contain exactly "left" and "right"';
      end if;
      return coalesce(
        private.entries_error(p_options -> 'left', 2, 10, 'left'),
        private.entries_error(p_options -> 'right', 2, 15, 'right'),
        case when jsonb_array_length(p_options -> 'right') < jsonb_array_length(p_options -> 'left')
             then 'right needs at least as many entries as left' end);
    when 'classification' then
      if v_keys <> array['categories', 'items'] then
        return 'options_json must contain exactly "categories" and "items"';
      end if;
      return coalesce(private.entries_error(p_options -> 'categories', 2, 6, 'categories'),
                      private.entries_error(p_options -> 'items', 2, 15, 'items'));
    when 'choice_matrix' then
      if v_keys <> array['columns', 'rows'] then
        return 'options_json must contain exactly "rows" and "columns"';
      end if;
      return coalesce(private.entries_error(p_options -> 'rows', 1, 15, 'rows'),
                      private.entries_error(p_options -> 'columns', 2, 6, 'columns'));
    when 'dropdown', 'cloze' then
      if v_keys <> array['blanks', 'text'] then
        return 'options_json must contain exactly "text" and "blanks"';
      end if;
      if jsonb_typeof(p_options -> 'blanks') is distinct from 'array'
         or jsonb_array_length(p_options -> 'blanks') not between 1 and 20 then
        return 'blanks must be an array of 1-20 blanks';
      end if;
      for v in select value from jsonb_array_elements(p_options -> 'blanks') loop
        if jsonb_typeof(v) is distinct from 'object'
           or jsonb_typeof(v -> 'id') is distinct from 'string' or (v ->> 'id') !~ '^[a-z0-9]{1,8}$' then
          return 'each blank needs an id matching [a-z0-9]{1,8}';
        end if;
        if (v ->> 'id') = any (v_ids) then
          return 'duplicate blank id';
        end if;
        v_ids := v_ids || (v ->> 'id');
        if p_type = 'dropdown' then
          if exists (select 1 from jsonb_object_keys(v) k where k not in ('id', 'options')) then
            return 'a dropdown blank may only contain id and options';
          end if;
          v_err := coalesce(private.entries_error(v -> 'options', 2, 10, 'blank options'),
                            private.text_only_error(v -> 'options', 'dropdown options'));
          if v_err is not null then
            return v_err;
          end if;
        else
          if exists (select 1 from jsonb_object_keys(v) k where k not in ('id', 'kind'))
             or coalesce(v ->> 'kind', 'text') not in ('text', 'number') then
            return 'a cloze blank may only contain id and kind ("text" | "number")';
          end if;
        end if;
      end loop;
      return private.template_error(p_options -> 'text', v_ids);
    when 'image_labelling' then
      if v_keys <> array['labels', 'markers'] then
        return 'options_json must contain exactly "markers" and "labels"';
      end if;
      if jsonb_typeof(p_options -> 'markers') is distinct from 'array'
         or jsonb_array_length(p_options -> 'markers') not between 1 and 15 then
        return 'markers must be an array of 1-15 markers';
      end if;
      for v in select value from jsonb_array_elements(p_options -> 'markers') loop
        if jsonb_typeof(v) is distinct from 'object'
           or exists (select 1 from jsonb_object_keys(v) k where k not in ('id', 'x', 'y'))
           or jsonb_typeof(v -> 'id') is distinct from 'string' or (v ->> 'id') !~ '^[a-z0-9]{1,8}$'
           or jsonb_typeof(v -> 'x') is distinct from 'number' or jsonb_typeof(v -> 'y') is distinct from 'number' then
          return 'a marker is {id, x, y}';
        end if;
        if (v ->> 'x')::numeric not between 0 and 100 or (v ->> 'y')::numeric not between 0 and 100 then
          return 'marker x and y are percentages of the image (0-100)';
        end if;
        if (v ->> 'id') = any (v_ids) then
          return 'duplicate marker id';
        end if;
        v_ids := v_ids || (v ->> 'id');
      end loop;
      return coalesce(private.entries_error(p_options -> 'labels', 2, 20, 'labels'),
                      private.text_only_error(p_options -> 'labels', 'labels'));
    when 'true_false' then
      if p_options <> '{}'::jsonb then
        return 'true_false takes no options';
      end if;
    when 'numeric' then
      if exists (select 1 from jsonb_object_keys(p_options) k where k <> 'unit') then
        return 'numeric options may only contain "unit"';
      end if;
      if p_options ? 'unit' and (jsonb_typeof(p_options -> 'unit') is distinct from 'string'
                                 or char_length(p_options ->> 'unit') > 32) then
        return 'unit must be a short string';
      end if;
    else
      return 'unknown item_type';
  end case;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Cloze key / response
-- ---------------------------------------------------------------------
create or replace function private.cloze_key_error(p_options jsonb, p_answer jsonb)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  b jsonb;
  k jsonb;
begin
  if exists (select 1 from jsonb_object_keys(p_answer) x where x <> 'blanks')
     or jsonb_typeof(p_answer -> 'blanks') is distinct from 'object' then
    return 'answer_json must be {"blanks": {blank id: answer}}';
  end if;
  if exists (select 1 from jsonb_object_keys(p_answer -> 'blanks') x
              where not x = any (private.ids_of(p_options -> 'blanks'))) then
    return 'unknown blank';
  end if;
  for b in select value from jsonb_array_elements(p_options -> 'blanks') loop
    k := p_answer -> 'blanks' -> (b ->> 'id');
    if k is null then
      return 'every blank needs an answer';
    end if;
    if coalesce(b ->> 'kind', 'text') = 'number' then
      if jsonb_typeof(k) is distinct from 'object'
         or exists (select 1 from jsonb_object_keys(k) x where x not in ('value', 'tolerance'))
         or jsonb_typeof(k -> 'value') is distinct from 'number'
         or (k ? 'tolerance' and (jsonb_typeof(k -> 'tolerance') is distinct from 'number'
                                  or (k ->> 'tolerance')::numeric < 0)) then
        return 'a number blank needs {"value": number, "tolerance": number >= 0}';
      end if;
    else
      if jsonb_typeof(k) is distinct from 'object'
         or exists (select 1 from jsonb_object_keys(k) x where x <> 'accept')
         or jsonb_typeof(k -> 'accept') is distinct from 'array'
         or jsonb_array_length(k -> 'accept') not between 1 and 10
         or exists (select 1 from jsonb_array_elements(k -> 'accept') a
                     where jsonb_typeof(a) <> 'string'
                        or private.normalize_answer(a #>> '{}') = ''
                        or char_length(a #>> '{}') > 200) then
        return 'a text blank needs {"accept": [1-10 answers, 1-200 characters]}';
      end if;
    end if;
  end loop;
  return null;
end;
$$;

create or replace function private.cloze_response_error(p_options jsonb, p_response jsonb)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  kv record;
  v_kind text;
begin
  if exists (select 1 from jsonb_object_keys(p_response) x where x <> 'blanks')
     or jsonb_typeof(p_response -> 'blanks') is distinct from 'object' then
    return 'expected {"blanks": {blank id: answer}}';
  end if;
  for kv in select * from jsonb_each(p_response -> 'blanks') loop
    select coalesce(b ->> 'kind', 'text') into v_kind
      from jsonb_array_elements(p_options -> 'blanks') b where b ->> 'id' = kv.key;
    if v_kind is null then
      return 'unknown blank';
    end if;
    if v_kind = 'number' then
      if jsonb_typeof(kv.value) is distinct from 'number' or abs((kv.value #>> '{}')::numeric) > 1e12 then
        return 'a number blank takes a number';
      end if;
    elsif jsonb_typeof(kv.value) is distinct from 'string' or char_length(kv.value #>> '{}') > 200 then
      return 'a text blank takes text up to 200 characters';
    end if;
  end loop;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Keys, responses, scoring: dispatch (group A unchanged)
-- ---------------------------------------------------------------------
create or replace function private.answer_key_error(p_type text, p_options jsonb, p_answer jsonb, p_scoring jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids text[];
  v_correct text[];
begin
  if jsonb_typeof(p_answer) is distinct from 'object' or jsonb_typeof(p_scoring) is distinct from 'object' then
    return 'answer_json and scoring_json must be objects';
  end if;

  case p_type
    when 'mcq_single', 'mcq_multiple' then
      if exists (select 1 from jsonb_object_keys(p_answer) k where k <> 'correct')
         or jsonb_typeof(p_answer -> 'correct') is distinct from 'array' then
        return 'answer_json must be {"correct": [choice ids]}';
      end if;
      if exists (select 1 from jsonb_array_elements(p_answer -> 'correct') e where jsonb_typeof(e) <> 'string') then
        return 'answer_json must be {"correct": [choice ids]}';
      end if;
      v_ids := private.ids_of(p_options -> 'options');
      select array_agg(e) into v_correct from jsonb_array_elements_text(p_answer -> 'correct') e;
      if v_correct is null or cardinality(v_correct) <> (select count(distinct x) from unnest(v_correct) x) then
        return 'correct choices must be a non-empty list without duplicates';
      end if;
      if not (v_correct <@ v_ids) then
        return 'correct choice id does not exist in the item';
      end if;
      if p_type = 'mcq_single' then
        if cardinality(v_correct) <> 1 then
          return 'mcq_single needs exactly one correct choice';
        end if;
        if p_scoring <> '{}'::jsonb then
          return 'mcq_single takes no scoring options';
        end if;
      elsif exists (select 1 from jsonb_object_keys(p_scoring) k where k <> 'mode')
            or coalesce(p_scoring ->> 'mode', 'all_or_nothing') not in ('all_or_nothing', 'partial') then
        return 'scoring_json must be {"mode": "all_or_nothing" | "partial"}';
      end if;
    when 'ordering' then
      if exists (select 1 from jsonb_object_keys(p_answer) k where k <> 'order')
         or jsonb_typeof(p_answer -> 'order') is distinct from 'array'
         or exists (select 1 from jsonb_array_elements(p_answer -> 'order') e where jsonb_typeof(e) <> 'string') then
        return 'answer_json must be {"order": [every option id once]}';
      end if;
      v_ids := private.ids_of(p_options -> 'options');
      select array_agg(e) into v_correct from jsonb_array_elements_text(p_answer -> 'order') e;
      if v_correct is null or cardinality(v_correct) <> cardinality(v_ids)
         or not (v_correct <@ v_ids and v_ids <@ v_correct) then
        return 'answer_json must be {"order": [every option id once]}';
      end if;
      return private.scoring_mode_error(p_scoring);
    when 'matching', 'classification', 'choice_matrix', 'dropdown', 'image_labelling' then
      if exists (select 1 from jsonb_object_keys(p_answer) k where k <> 'slots') then
        return 'answer_json must be {"slots": {slot id: choice id}}';
      end if;
      return coalesce(private.slot_map_error(p_type, p_options, p_answer -> 'slots', true, p_type = 'matching'),
                      private.scoring_mode_error(p_scoring));
    when 'cloze' then
      return coalesce(private.cloze_key_error(p_options, p_answer), private.scoring_mode_error(p_scoring));
    when 'true_false' then
      if exists (select 1 from jsonb_object_keys(p_answer) k where k <> 'correct')
         or jsonb_typeof(p_answer -> 'correct') is distinct from 'boolean' then
        return 'answer_json must be {"correct": true|false}';
      end if;
      if p_scoring <> '{}'::jsonb then
        return 'true_false takes no scoring options';
      end if;
    when 'numeric' then
      if exists (select 1 from jsonb_object_keys(p_answer) k where k not in ('value', 'tolerance'))
         or jsonb_typeof(p_answer -> 'value') is distinct from 'number'
         or (p_answer ? 'tolerance' and jsonb_typeof(p_answer -> 'tolerance') is distinct from 'number') then
        return 'answer_json must be {"value": number, "tolerance": number >= 0}';
      end if;
      if coalesce((p_answer ->> 'tolerance')::numeric, 0) < 0 then
        return 'answer_json must be {"value": number, "tolerance": number >= 0}';
      end if;
      if p_scoring <> '{}'::jsonb then
        return 'numeric takes no scoring options';
      end if;
    else
      return 'unknown item_type';
  end case;
  return null;
end;
$$;

create or replace function private.response_error(p_type text, p_options jsonb, p_response jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids text[];
  v_sel text[];
begin
  if jsonb_typeof(p_response) is distinct from 'object' then
    return 'response must be an object';
  end if;
  v_ids := private.ids_of(p_options -> 'options');

  case p_type
    when 'mcq_single' then
      if exists (select 1 from jsonb_object_keys(p_response) k where k <> 'choice')
         or jsonb_typeof(p_response -> 'choice') is distinct from 'string'
         or not ((p_response ->> 'choice') = any (v_ids)) then
        return 'expected {"choice": <choice id>}';
      end if;
    when 'mcq_multiple' then
      if exists (select 1 from jsonb_object_keys(p_response) k where k <> 'choices')
         or jsonb_typeof(p_response -> 'choices') is distinct from 'array' then
        return 'expected {"choices": [choice ids]}';
      end if;
      if exists (select 1 from jsonb_array_elements(p_response -> 'choices') e where jsonb_typeof(e) <> 'string') then
        return 'expected {"choices": [choice ids]}';
      end if;
      select array_agg(e) into v_sel from jsonb_array_elements_text(p_response -> 'choices') e;
      if v_sel is null
         or cardinality(v_sel) <> (select count(distinct x) from unnest(v_sel) x)
         or not (v_sel <@ v_ids) then
        return 'choices must be existing ids without duplicates';
      end if;
    when 'ordering' then
      if exists (select 1 from jsonb_object_keys(p_response) k where k <> 'order')
         or jsonb_typeof(p_response -> 'order') is distinct from 'array'
         or exists (select 1 from jsonb_array_elements(p_response -> 'order') e where jsonb_typeof(e) <> 'string') then
        return 'expected {"order": [every option id once]}';
      end if;
      select array_agg(e) into v_sel from jsonb_array_elements_text(p_response -> 'order') e;
      if v_sel is null or cardinality(v_sel) <> cardinality(v_ids) or not (v_sel <@ v_ids and v_ids <@ v_sel) then
        return 'expected {"order": [every option id once]}';
      end if;
    when 'matching', 'classification', 'choice_matrix', 'dropdown', 'image_labelling' then
      if exists (select 1 from jsonb_object_keys(p_response) k where k <> 'slots') or not p_response ? 'slots' then
        return 'expected {"slots": {slot id: choice id}}';
      end if;
      return private.slot_map_error(p_type, p_options, p_response -> 'slots', false, false);
    when 'cloze' then
      return private.cloze_response_error(p_options, p_response);
    when 'true_false' then
      if exists (select 1 from jsonb_object_keys(p_response) k where k <> 'value')
         or jsonb_typeof(p_response -> 'value') is distinct from 'boolean' then
        return 'expected {"value": true|false}';
      end if;
    when 'numeric' then
      if exists (select 1 from jsonb_object_keys(p_response) k where k <> 'value')
         or jsonb_typeof(p_response -> 'value') is distinct from 'number' then
        return 'expected {"value": number}';
      end if;
      if abs((p_response ->> 'value')::numeric) > 1e12 then
        return 'value out of range';
      end if;
    else
      return 'unknown item_type';
  end case;
  return null;
end;
$$;

create or replace function private.score_response(
  p_type text, p_answer jsonb, p_scoring jsonb, p_response jsonb
) returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text[];
  v_sel text[];
  v_hit integer;
  v_n integer;
begin
  case p_type
    when 'mcq_single' then
      return case when (p_response ->> 'choice') = (p_answer -> 'correct' ->> 0) then 1 else 0 end;
    when 'mcq_multiple' then
      select array_agg(e) into v_key from jsonb_array_elements_text(p_answer -> 'correct') e;
      select array_agg(e) into v_sel from jsonb_array_elements_text(p_response -> 'choices') e;
      if coalesce(p_scoring ->> 'mode', 'all_or_nothing') = 'partial' then
        v_hit := (select count(*) from unnest(v_sel) s where s = any (v_key));
        return greatest(0, v_hit - (cardinality(v_sel) - v_hit))::numeric / cardinality(v_key);
      end if;
      return case when v_sel <@ v_key and v_key <@ v_sel then 1 else 0 end;
    when 'ordering' then
      select count(*), count(*) filter (where k.v = r.v) into v_n, v_hit
        from jsonb_array_elements_text(p_answer -> 'order') with ordinality k(v, i)
        join jsonb_array_elements_text(p_response -> 'order') with ordinality r(v, i) on r.i = k.i;
    when 'matching', 'classification', 'choice_matrix', 'dropdown', 'image_labelling' then
      select count(*), count(*) filter (where (p_response -> 'slots' ->> kv.key) = kv.value) into v_n, v_hit
        from jsonb_each_text(p_answer -> 'slots') kv;
    when 'cloze' then
      select count(*),
             count(*) filter (where
               case when kv.value ? 'value' then
                      jsonb_typeof(p_response -> 'blanks' -> kv.key) = 'number'
                      and abs((p_response -> 'blanks' ->> kv.key)::numeric - (kv.value ->> 'value')::numeric)
                          <= coalesce((kv.value ->> 'tolerance')::numeric, 0)
                    else
                      jsonb_typeof(p_response -> 'blanks' -> kv.key) = 'string'
                      and exists (select 1 from jsonb_array_elements_text(kv.value -> 'accept') a
                                   where private.normalize_answer(a) = private.normalize_answer(p_response -> 'blanks' ->> kv.key)
                                     and private.normalize_answer(a) <> '')
               end)
        into v_n, v_hit
        from jsonb_each(p_answer -> 'blanks') kv;
    when 'true_false' then
      return case when (p_response -> 'value') = (p_answer -> 'correct') then 1 else 0 end;
    when 'numeric' then
      return case
        when abs((p_response ->> 'value')::numeric - (p_answer ->> 'value')::numeric)
             <= coalesce((p_answer ->> 'tolerance')::numeric, 0) then 1
        else 0 end;
    else
      raise exception 'no scorer for item type %', p_type;
  end case;
  -- ordering, slot types and cloze (partial is their default)
  if v_n = 0 then
    return 0;
  end if;
  if coalesce(p_scoring ->> 'mode', 'partial') = 'all_or_nothing' then
    return case when v_hit = v_n then 1 else 0 end;
  end if;
  return v_hit::numeric / v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- Image labelling needs its image
-- ---------------------------------------------------------------------
create or replace function private.instrument_items_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version uuid := case when tg_op = 'DELETE' then old.instrument_version_id else new.instrument_version_id end;
  v_status text;
  v_instrument uuid;
  v_error text;
  v_path text;
begin
  select v.status, v.instrument_id into v_status, v_instrument
    from public.instrument_versions v where v.id = v_version
     for share;
  if v_status is distinct from 'draft'
     or (tg_op = 'UPDATE' and new.instrument_version_id <> old.instrument_version_id) then
    raise exception 'items of a published version cannot change (create a new version instead)'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  v_error := private.item_shape_error(new.item_type, new.options_json);
  if v_error is null and new.item_type = 'image_labelling' and new.media_path is null then
    v_error := 'image_labelling needs its image (media_path)';
  end if;
  if v_error is not null then
    raise exception 'invalid item: %', v_error using errcode = 'check_violation';
  end if;

  for v_path in
    select new.media_path
    union all
    select p from private.options_media_paths(new.options_json) p
  loop
    if v_path is not null
       and (not starts_with(v_path, v_instrument::text || '/') or v_path ~ '(^|/)\.\.(/|$)') then
      raise exception 'invalid item: media must be stored under the instrument folder'
        using errcode = 'check_violation';
    end if;
  end loop;

  -- A changed item type makes the old answer key meaningless.
  if tg_op = 'UPDATE' and new.item_type <> old.item_type then
    delete from private.instrument_answer_keys where item_id = old.id;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Presentation: + dropdown options per blank ("blank:<id>") and labels
-- ---------------------------------------------------------------------
create or replace function private.build_presentation(p_version uuid, p_shuffle_items boolean, p_shuffle_choices boolean)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_items jsonb;
  v_lists jsonb := '{}'::jsonb;
  v_item record;
  v_name text;
  v_order jsonb;
  v_key jsonb;
  v_try integer;
  v_item_lists jsonb;
  v_source jsonb;
begin
  select coalesce(jsonb_agg(i.id order by case when p_shuffle_items then random() else i.display_order::double precision end), '[]'::jsonb)
    into v_items
    from public.instrument_items i where i.instrument_version_id = p_version;

  for v_item in
    select i.id, i.item_type, i.options_json, k.answer_json
      from public.instrument_items i
      left join private.instrument_answer_keys k on k.item_id = i.id
     where i.instrument_version_id = p_version
  loop
    v_item_lists := '{}'::jsonb;
    foreach v_name in array (
      case v_item.item_type
        when 'ordering' then array['options']
        when 'matching' then case when p_shuffle_choices then array['right', 'left'] else array['right'] end
        when 'classification' then case when p_shuffle_choices then array['items'] else '{}'::text[] end
        when 'choice_matrix' then case when p_shuffle_choices then array['rows'] else '{}'::text[] end
        when 'mcq_single' then case when p_shuffle_choices then array['options'] else '{}'::text[] end
        when 'mcq_multiple' then case when p_shuffle_choices then array['options'] else '{}'::text[] end
        when 'image_labelling' then case when p_shuffle_choices then array['labels'] else '{}'::text[] end
        when 'dropdown' then case when p_shuffle_choices
                                  then array(select 'blank:' || (b ->> 'id') from jsonb_array_elements(v_item.options_json -> 'blanks') b)
                                  else '{}'::text[] end
        else '{}'::text[]
      end)
    loop
      v_source := case when v_name like 'blank:%'
                       then (select b -> 'options' from jsonb_array_elements(v_item.options_json -> 'blanks') b
                              where 'blank:' || (b ->> 'id') = v_name)
                       else v_item.options_json -> v_name end;
      v_key := case when v_item.item_type = 'ordering' then v_item.answer_json -> 'order' end;
      v_try := 0;
      loop
        select jsonb_agg(e ->> 'id' order by random()) into v_order from jsonb_array_elements(v_source) e;
        v_try := v_try + 1;
        -- an ordering list never starts out already in the correct order
        exit when v_key is null or v_order <> v_key or v_try >= 20;
      end loop;
      v_item_lists := v_item_lists || jsonb_build_object(v_name, v_order);
    end loop;
    if v_item_lists <> '{}'::jsonb then
      v_lists := v_lists || jsonb_build_object(v_item.id::text, v_item_lists);
    end if;
  end loop;

  return jsonb_build_object('items', v_items, 'lists', v_lists);
end;
$$;

revoke all on function private.normalize_answer(text) from public;
revoke all on function private.template_error(jsonb, text[]) from public;
revoke all on function private.text_only_error(jsonb, text) from public;
revoke all on function private.cloze_key_error(jsonb, jsonb) from public;
revoke all on function private.cloze_response_error(jsonb, jsonb) from public;

comment on function private.normalize_answer(text) is 'เทียบคำตอบเติมคำ: NFKC (ำ/ํา), ลำดับวรรณยุกต์กับ ํ, เลขไทย→อารบิก, ตัดอักขระที่มองไม่เห็น, ช่องว่าง, ตัวพิมพ์เล็ก — ไม่ตรวจคำสะกดใกล้เคียง';
