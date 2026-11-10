-- Phase 4g step 5 (review): what step 4 could not show, and one rule tightened.
--
-- 1. my_cohort_courses() — the cohorts the caller is an active TRAINEE of, each
--    with its programme's published courses and the caller's own enrollment.
--    A trainee who is not yet enrolled cannot read a course row
--    (authz.can_view_course needs an enrollment), and list_open_cohorts only
--    lists cohorts open for joining — so someone a manager added to a cohort
--    that is closed to joining could not see or choose its courses.
--    Only titles and the caller's own rows: nothing about other people.
--
-- 2. enroll_in_course: a trainee enrolls THEMSELF only while the cohort is
--    running (status open / in_progress) in an active programme — not in a
--    cohort that has ended or been archived (SE014). Managers and Staff still
--    may enroll at any time. Two presses at once no longer fail on the unique key.

create or replace function public.enroll_in_course(p_cohort uuid, p_course uuid, p_user uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_user uuid := coalesce(p_user, auth.uid());
  v_self boolean := p_user is null or p_user = auth.uid();
  v_id uuid;
begin
  if v_actor is null or not authz.is_active_user() then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if not v_self and not (authz.can_manage_cohort(p_cohort) or authz.is_platform_support()) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.cohort_memberships m
                  where m.cohort_id = p_cohort and m.user_id = v_user
                    and m.cohort_role = 'trainee' and m.status = 'active') then
    raise exception 'not a trainee of this cohort' using errcode = 'SE013';
  end if;
  if not exists (select 1 from public.cohorts c
                   join public.program_courses pc on pc.program_id = c.program_id
                   join public.courses co on co.id = pc.course_id
                  where c.id = p_cohort and co.id = p_course
                    and (co.status = 'published' or not v_self)) then
    raise exception 'course not in this cohort''s programme' using errcode = 'SE013';
  end if;
  if v_self and not exists (select 1 from public.cohorts c join public.programs p on p.id = c.program_id
                             where c.id = p_cohort and c.status in ('open', 'in_progress') and p.status = 'active') then
    raise exception 'the cohort is not running' using errcode = 'SE014';
  end if;

  insert into public.course_enrollments (cohort_id, course_id, user_id)
  values (p_cohort, p_course, v_user)
  on conflict (cohort_id, course_id, user_id) do nothing
  returning id into v_id;
  if v_id is null then -- enrolled before (or a second press at the same moment)
    select e.id into v_id from public.course_enrollments e
     where e.cohort_id = p_cohort and e.course_id = p_course and e.user_id = v_user for update;
    update public.course_enrollments set status = 'active' where id = v_id and status = 'withdrawn';
  end if;
  return v_id;
end;
$$;
revoke execute on function public.enroll_in_course(uuid, uuid, uuid) from public, anon;
grant execute on function public.enroll_in_course(uuid, uuid, uuid) to authenticated;

create function public.my_cohort_courses()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null or not authz.is_active_user() then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'cohort_id', c.id, 'cohort_code', c.code, 'cohort_name', c.name, 'cohort_status', c.status,
             'start_at', c.start_at, 'end_at', c.end_at,
             'program_name', p.name, 'fiscal_year', p.fiscal_year, 'owner_org', o.name,
             'can_enroll', c.status in ('open', 'in_progress') and p.status = 'active',
             'courses', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id', co.id, 'title', co.title,
                        'enrollment_id', e.id, 'enrollment_status', e.status)
                      order by pc.display_order, co.title)
                 from public.program_courses pc
                 join public.courses co on co.id = pc.course_id
                 left join public.course_enrollments e
                   on e.cohort_id = c.id and e.course_id = co.id and e.user_id = v_me
                where pc.program_id = p.id and co.status = 'published'), '[]'::jsonb))
           order by c.start_at nulls last, p.name, c.name)
      from public.cohort_memberships m
      join public.cohorts c on c.id = m.cohort_id
      join public.programs p on p.id = c.program_id
      join public.organizations o on o.id = p.owner_org_id
     where m.user_id = v_me and m.cohort_role = 'trainee' and m.status = 'active'
       and c.status <> 'archived'), '[]'::jsonb);
end;
$$;
revoke execute on function public.my_cohort_courses() from public, anon;
grant execute on function public.my_cohort_courses() to authenticated;
comment on function public.my_cohort_courses() is
  'รุ่นที่ผู้เรียกเป็นผู้เข้าอบรม พร้อมหลักสูตรที่เผยแพร่ของโครงการและสถานะลงทะเบียนของตนเอง — ไม่มีข้อมูลของคนอื่น (4g)';
comment on function public.enroll_in_course(uuid, uuid, uuid) is
  'ลงทะเบียนหลักสูตรของโครงการให้ผู้เข้าอบรมของรุ่น: ตนเอง (หลักสูตรที่เผยแพร่ ขณะรุ่นเปิดรับ/กำลังอบรมในโครงการที่ดำเนินการ — SE014) หรือผู้จัดการรุ่น/Staff ได้ทุกเมื่อ (4g)';
