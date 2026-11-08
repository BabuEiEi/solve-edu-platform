import { execFileSync } from 'node:child_process'
import { test, expect } from './fixtures.js'
import { signIn } from './helpers.js'

/**
 * Delete what nobody used, archive what somebody did — through the pages.
 * Fixtures are fictitious and made with SQL (the pages under test are the
 * delete zones, not the course builder).
 */
const sql = (text) =>
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'supabase_db_solve-edu-platform',
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    { input: text, encoding: 'utf8' }
  ).trim()
const count = (table, where) =>
  Number(sql(`select count(*) from ${table.includes('.') ? table : `public.${table}`} where ${where};`))

const DISTRICT = '10000000-0000-4000-a000-000000000001'
const A = '40000000-0000-4000-a000-00000000e2e1' // unused course, with a quiz, a rubric, a task, a unit
const B = '40000000-0000-4000-a000-00000000e2e2' // a course with a learner enrolled
const tag = Date.now().toString(36)
const CODE = { a: `E2E-A-${tag}`, quiz: `E2E-Q-${tag}`, rubric: `E2E-R-${tag}`, b: `E2E-B-${tag}` }

test('unused course, quiz and rubric are deleted with their typed codes; a course with a learner can only be archived', async ({
  page,
}) => {
  sql(`
    insert into public.courses (id, code, title, owner_org_id, status) values
      ('${A}', '${CODE.a}', 'หลักสูตรทดลองลบ (สมมติ)', '${DISTRICT}', 'draft'),
      ('${B}', '${CODE.b}', 'หลักสูตรมีผู้เรียน (สมมติ)', '${DISTRICT}', 'published');
    insert into public.course_units (id, course_id, title, display_order) values ('50000000-0000-4000-a000-00000000e2e1', '${A}', 'หน่วยทดลอง', 1);
    insert into public.instruments (id, owner_org_id, course_id, code, title, instrument_type) values
      ('a1000000-0000-4000-a000-00000000e2e1', '${DISTRICT}', '${A}', '${CODE.quiz}', 'แบบทดสอบทดลองลบ', 'quiz'),
      ('a1000000-0000-4000-a000-00000000e2e2', '${DISTRICT}', '${A}', '${CODE.rubric}', 'Rubric ทดลองลบ', 'rubric');
    insert into public.instrument_versions (instrument_id, version_no) values
      ('a1000000-0000-4000-a000-00000000e2e1', 1), ('a1000000-0000-4000-a000-00000000e2e2', 1);
    insert into public.tasks (course_id, title) values ('${A}', 'งานทดลองลบ (สมมติ)');
    insert into public.program_courses (program_id, course_id, display_order)
      values ('20000000-0000-4000-a000-000000000001', '${B}', 8);
    insert into public.course_enrollments (cohort_id, course_id, user_id)
      values ('30000000-0000-4000-a000-000000000001', '${B}', '00000000-0000-4000-a000-000000000008');`)

  await signIn(page, 'district.admin@example.test')
  const zone = page.locator('[data-delete-zone]')
  const typeCode = async (code) => {
    await zone.getByRole('button', { name: /^ลบ.*…$/ }).click()
    const confirmBtn = zone.locator('[data-zone-confirm]')
    await expect(confirmBtn).toBeDisabled()
    await zone.locator('input[name=confirm]').fill(code.toLowerCase())
    await expect(confirmBtn).toBeDisabled() // case counts
    await zone.locator('input[name=confirm]').fill(code)
    await expect(confirmBtn).toBeEnabled()
    return confirmBtn
  }

  // a quiz nobody took
  await page.goto(`/#/courses/${A}/quizzes/a1000000-0000-4000-a000-00000000e2e1`)
  await expect(zone).toContainText('ยังไม่มีผู้ใช้แบบทดสอบนี้')
  await (await typeCode(CODE.quiz)).click()
  await expect(page).toHaveURL(new RegExp(`#/courses/${A}/quizzes$`))
  expect(count('instruments', `code = '${CODE.quiz}'`)).toBe(0)

  // a rubric nobody chose — the wording says Rubric
  await page.goto(`/#/courses/${A}/rubrics/a1000000-0000-4000-a000-00000000e2e2`)
  await expect(zone).toContainText('ลบRubric')
  await (await typeCode(CODE.rubric)).click()
  await expect(page).toHaveURL(new RegExp(`#/courses/${A}/rubrics$`))
  expect(count('instruments', `code = '${CODE.rubric}'`)).toBe(0)

  // the course: unit and task go with it
  await page.goto(`/#/courses/${A}/builder`)
  await expect(zone).toContainText('ยังไม่มีผู้ใช้หลักสูตรนี้')
  const confirmBtn = await typeCode(CODE.a)
  if (process.env.SHOT_DIR) {
    await page.screenshot({
      path: `${process.env.SHOT_DIR}/delete-${test.info().project.name}.png`,
      fullPage: true,
    })
  }
  await confirmBtn.click()
  await expect(page).toHaveURL(/#\/courses$/)
  await expect(page.getByText(CODE.a)).toHaveCount(0)
  expect(
    count('courses', `id = '${A}'`) +
      count('course_units', `course_id = '${A}'`) +
      count('tasks', `course_id = '${A}'`)
  ).toBe(0)
  expect(
    count(
      'private.audit_logs',
      `action = 'DELETE' and before_json->>'code' in ('${CODE.a}', '${CODE.quiz}', '${CODE.rubric}')`
    )
  ).toBe(3)

  // a course with a learner: reasons, no delete, archive instead
  await page.goto(`/#/courses/${B}/builder`)
  await expect(zone).toContainText('ลบหลักสูตรนี้ไม่ได้')
  await expect(zone.locator('[data-reasons]')).toContainText('มีผู้ลงทะเบียนเรียน 1 คน')
  await expect(zone.getByRole('button', { name: /^ลบ.*…$/ })).toHaveCount(0)
  await zone.getByRole('button', { name: 'เก็บถาวรหลักสูตร' }).click()
  await expect(page.getByText('เก็บถาวรหลักสูตรแล้ว')).toBeVisible()
  await expect(zone.getByRole('button', { name: 'เก็บถาวรหลักสูตร' })).toHaveCount(0) // already archived
  await expect(zone.locator('[data-reasons]')).toContainText('มีผู้ลงทะเบียนเรียน 1 คน') // still cannot be deleted
  expect(sql(`select status from public.courses where id = '${B}';`)).toBe('archived')
  expect(count('course_enrollments', `course_id = '${B}'`)).toBe(1) // the learner's record is untouched
})
