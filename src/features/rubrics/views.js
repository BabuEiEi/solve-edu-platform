import { html, render } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, statusBadge, loading } from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { navigate } from '../../core/router.js'
import { watchDeleteZones } from '../deletion/zone.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'
import { moveId, nextOrder } from '../builder/service.js'
import { defaultVersion } from '../quizzes/logic.js'
import {
  MIN_LEVELS,
  MAX_LEVELS,
  buildCriterionDraft,
  defaultLevels,
  nextLevelId,
  rubricMaxScore,
  sortedLevels,
} from './logic.js'

const input =
  'mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const label = 'block text-sm font-medium text-ink-700'
const primary =
  'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-60'
const secondary = 'rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50'
const iconBtn =
  'rounded-md border border-ink-200 bg-white px-2 py-1 text-xs text-ink-600 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40'
const dangerBtn =
  'rounded-md border border-rose-200 bg-white px-2 py-1 text-xs text-rose-700 hover:bg-rose-50'

const accessDenied = () =>
  html`${pageHeader('Rubric ของหลักสูตร')}${emptyState('ท่านไม่มีสิทธิ์จัดการ Rubric ของหลักสูตรนี้ หรือไม่พบหลักสูตร')}`
const versionLabel = (v) => `ฉบับที่ ${v.version_no}`

async function loadManagedCourse(services, courseId) {
  if ((await services.courses.getAccess(courseId)) !== 'manage') return null
  return services.builder.getCourseTree(courseId)
}

// =====================================================================
// #/courses/:id/rubrics — the rubrics of a course
// =====================================================================
export async function renderCourseRubricsView(el, { services }, { id }) {
  render(el, loading)
  let course, rubrics
  try {
    course = await loadManagedCourse(services, id)
    if (!course) return render(el, accessDenied())
    rubrics = await services.quizzes.listForCourse(id, 'rubric')
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }
  let message = null

  const draw = () =>
    render(
      el,
      html`<a href="#/courses/${course.id}/builder" class="text-sm text-brand-700 hover:underline">← ${course.title}</a>
        ${pageHeader('Rubric ของหลักสูตร', 'เกณฑ์ตรวจงาน: หลายเกณฑ์ หลายระดับ (ฉบับที่เผยแพร่แล้วแก้ไขไม่ได้ คะแนนที่ให้ไปแล้วจึงยังหมายความเหมือนเดิม)')}
        ${
          rubrics.length
            ? html`<ul class="space-y-3" data-rubrics>
                ${[...rubrics]
                  .sort((a, b) => (a.status === 'archived') - (b.status === 'archived'))
                  .map((r) => {
                    const current = defaultVersion(r.instrument_versions)
                    return html`<li>
                    <a
                      href="#/courses/${course.id}/rubrics/${r.id}"
                      class="flex flex-wrap items-center gap-3 rounded-xl border border-ink-200 bg-white px-5 py-4 hover:border-brand-300"
                    >
                      <span class="min-w-0 flex-1">
                        <span class="block font-semibold text-ink-900">${r.title}</span>
                        <span class="text-xs text-ink-500">${r.code}</span>
                      </span>
                      ${current ? html`<span class="text-sm text-ink-500">${versionLabel(current)}</span>${statusBadge(current.status)}` : ''}
                      ${r.status === 'archived' ? html`<span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-500/20" data-archived-badge>เก็บถาวร</span>` : ''}
                    </a>
                  </li>`
                  })}
              </ul>`
            : emptyState('ยังไม่มี Rubric ในหลักสูตรนี้')
        }
        <form data-form="create-rubric" class="mt-6 grid gap-3 rounded-xl border border-dashed border-ink-200 bg-white p-5 sm:grid-cols-[200px_1fr]">
          <p class="text-sm font-semibold text-ink-800 sm:col-span-2">สร้าง Rubric ใหม่</p>
          ${message ? html`<div class="sm:col-span-2">${alertBox(message)}</div>` : ''}
          <label class="${label}">รหัส<input name="code" required maxlength="50" placeholder="เช่น RUB-LESSONPLAN" class="${input}" /></label>
          <label class="${label}">ชื่อ Rubric<input name="title" required maxlength="300" class="${input}" /></label>
          <label class="${label} sm:col-span-2"
            >คำอธิบาย (ไม่บังคับ)<textarea name="description" rows="2" maxlength="5000" class="${input}"></textarea>
          </label>
          <div><button class="${primary}" type="submit">สร้าง Rubric</button></div>
        </form>`
    )

  el.onsubmit = async (e) => {
    e.preventDefault()
    const f = Object.fromEntries(new FormData(e.target))
    const button = e.target.querySelector('button[type=submit]')
    button.disabled = true
    try {
      const created = await services.quizzes.createInstrument(course, f, 'rubric')
      navigate(`/courses/${course.id}/rubrics/${created.id}`)
    } catch (err) {
      message = toUserMessage(err)
      draw()
    }
  }

  draw()
}

// =====================================================================
// #/courses/:id/rubrics/:rubricId — versions, criteria, publish
// =====================================================================
function levelRow(level) {
  return html`<div class="grid gap-2 rounded-lg border border-ink-100 p-3 sm:grid-cols-[1fr_110px]" data-level-row>
    <input type="hidden" name="level_id" value="${level.id}" />
    <label class="${label}"
      >ชื่อระดับ<input name="level_label" maxlength="100" value="${level.label ?? ''}" class="${input}" placeholder="เช่น ดีมาก"
    /></label>
    <label class="${label}"
      >คะแนน<input name="level_score" inputmode="decimal" value="${level.score ?? ''}" class="${input}" placeholder="เช่น 4"
    /></label>
    <label class="${label} sm:col-span-2"
      >คำอธิบายระดับ (ไม่บังคับ)<textarea name="level_description" rows="2" maxlength="1000" class="${input}" placeholder="บอกว่างานแบบไหนได้ระดับนี้">${level.description ?? ''}</textarea>
    </label>
    <div class="sm:col-span-2">
      <button type="button" class="${dangerBtn}" data-action="remove-level">ลบระดับ</button>
    </div>
  </div>`
}

function criterionForm(criterion) {
  const o = criterion?.options_json ?? {}
  const levels = criterion
    ? o.levels.map((l) => ({
        id: l.id,
        label: l.label,
        score: String(l.score),
        description: l.description ?? '',
      }))
    : defaultLevels()
  return html`<form data-form="criterion" class="space-y-4 rounded-xl border-2 border-brand-200 bg-white p-5">
    <p class="text-sm font-semibold text-brand-700">${criterion ? 'แก้ไขเกณฑ์' : 'เพิ่มเกณฑ์'}</p>
    <label class="${label}"
      >ชื่อเกณฑ์<textarea name="prompt" required rows="2" maxlength="5000" class="${input}" placeholder="เช่น การกำหนดเป้าหมายการเรียนรู้">${criterion?.prompt ?? ''}</textarea>
    </label>
    <label class="${label}"
      >คำอธิบายเกณฑ์ (ไม่บังคับ)<textarea name="description" rows="2" maxlength="2000" class="${input}">${o.description ?? ''}</textarea>
    </label>
    <fieldset class="space-y-2">
      <legend class="${label}">ระดับ (${MIN_LEVELS}–${MAX_LEVELS} ระดับ แต่ละระดับคะแนนไม่ซ้ำกัน) — คะแนนสูงสุดคือคะแนนเต็มของเกณฑ์</legend>
      <div data-levels class="space-y-2">${levels.map((l) => levelRow(l))}</div>
      <button type="button" class="${secondary}" data-action="add-level">+ เพิ่มระดับ</button>
    </fieldset>
    <div data-form-error></div>
    <div class="flex gap-2">
      <button class="${primary}" type="submit">บันทึกเกณฑ์</button>
      <button class="${secondary}" type="button" data-action="cancel-criterion">ยกเลิก</button>
    </div>
  </form>`
}

export async function renderRubricEditorView(el, { services }, { id: courseId, rubricId }) {
  render(el, loading)
  let course, instrument, version, criteria
  let selectedVersionId = null
  let editing = null // { criterionId|null }
  let message = null
  let tone = 'success'
  let busy = false

  const load = async () => {
    instrument = await services.quizzes.getInstrument(rubricId)
    if (!instrument || instrument.course_id !== courseId || instrument.instrument_type !== 'rubric') return
    const versions = instrument.instrument_versions
    version = versions.find((v) => v.id === selectedVersionId) ?? defaultVersion(versions)
    criteria = version ? await services.quizzes.getItems(version.id) : []
  }

  try {
    course = await loadManagedCourse(services, courseId)
    if (!course) return render(el, accessDenied())
    await load()
    if (!instrument || instrument.course_id !== courseId || instrument.instrument_type !== 'rubric')
      return render(el, accessDenied())
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }

  const isDraft = () => version?.status === 'draft'
  const draftVersion = () => instrument.instrument_versions.find((v) => v.status === 'draft')

  const criterionCard = (c, index) => {
    if (editing?.criterionId === c.id) return html`<li>${criterionForm(c)}</li>`
    const levels = sortedLevels(c)
    return html`<li class="rounded-xl border border-ink-200 bg-white" data-criterion-id="${c.id}">
      <div class="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-2 text-sm">
        <span class="font-semibold text-brand-700">เกณฑ์ที่ ${index + 1}</span>
        <span class="text-ink-500">${levels.length} ระดับ · เต็ม ${Number(c.max_score)} คะแนน</span>
        <span class="flex-1"></span>
        ${
          isDraft()
            ? html`<span class="flex gap-1">
                <button type="button" class="${iconBtn}" data-action="move-criterion" data-id="${c.id}" data-delta="-1" ${index === 0 ? 'disabled' : ''} aria-label="เลื่อนขึ้น">↑</button>
                <button type="button" class="${iconBtn}" data-action="move-criterion" data-id="${c.id}" data-delta="1" ${index === criteria.length - 1 ? 'disabled' : ''} aria-label="เลื่อนลง">↓</button>
                <button type="button" class="${iconBtn}" data-action="edit-criterion" data-id="${c.id}">แก้ไข</button>
                <button type="button" class="${dangerBtn}" data-action="delete-criterion" data-id="${c.id}">ลบ</button>
              </span>`
            : ''
        }
      </div>
      <div class="space-y-2 p-4 text-sm">
        <p class="whitespace-pre-line font-medium text-ink-900">${c.prompt}</p>
        ${c.options_json?.description ? html`<p class="text-ink-600">${c.options_json.description}</p>` : ''}
        <ul class="grid gap-2 sm:grid-cols-2" data-levels-preview>
          ${levels.map(
            (l) => html`<li class="rounded-lg border border-ink-100 p-2">
              <span class="font-medium text-ink-800">${l.label}</span>
              <span class="ml-1 text-xs text-ink-500">${Number(l.score)} คะแนน</span>
              ${l.description ? html`<span class="mt-0.5 block text-xs text-ink-600">${l.description}</span>` : ''}
            </li>`
          )}
        </ul>
      </div>
    </li>`
  }

  const versionBar = () =>
    html`<nav class="flex flex-wrap gap-2" aria-label="ฉบับของ Rubric">
      ${[...instrument.instrument_versions].reverse().map(
        (v) =>
          html`<button
            type="button"
            data-action="select-version"
            data-id="${v.id}"
            class="${v.id === version?.id ? 'rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white' : secondary}"
            ${v.id === version?.id ? html`aria-current="true"` : ''}
          >
            ${versionLabel(v)} · ${v.status === 'draft' ? 'ร่าง' : v.status === 'published' ? 'เผยแพร่' : 'เก็บถาวร'}
          </button>`
      )}
    </nav>`

  const statusPanel = () => {
    if (!version) return emptyState('ยังไม่มีฉบับของ Rubric นี้')
    if (isDraft()) {
      const ready = criteria.length > 0
      return html`<section class="rounded-xl border border-ink-200 bg-white p-4 text-sm">
        <p class="text-ink-700">
          ${versionLabel(version)} เป็น<strong>ฉบับร่าง</strong> — แก้ไขได้ ยังนำไปใช้กับภาระงานไม่ได้ เมื่อเผยแพร่แล้วจะแก้ไขฉบับนี้ไม่ได้อีก
        </p>
        ${
          ready
            ? html`<p class="mt-2 text-emerald-700" data-ready>พร้อมเผยแพร่ (${criteria.length} เกณฑ์ · คะแนนเต็มรวม ${rubricMaxScore(criteria)})</p>`
            : html`<p class="mt-2 text-amber-800">ยังไม่มีเกณฑ์</p>`
        }
        <button type="button" class="${primary} mt-3" data-action="publish" ${ready ? '' : 'disabled'}>เผยแพร่ฉบับนี้</button>
      </section>`
    }
    const draft = draftVersion()
    return html`<section class="rounded-xl border border-ink-200 bg-white p-4 text-sm">
      <p class="text-ink-700">
        ${versionLabel(version)} ${statusBadge(version.status)} เมื่อ ${formatThaiDateTime(version.published_at)} — แก้ไขไม่ได้
        เพื่อให้คะแนนที่ให้ไปแล้วยังมีความหมายเดิม · คะแนนเต็มรวม ${rubricMaxScore(criteria)}
      </p>
      ${
        draft
          ? html`<button type="button" class="${secondary} mt-3" data-action="select-version" data-id="${draft.id}">
              ไปที่ฉบับร่าง (${versionLabel(draft)})
            </button>`
          : html`<button type="button" class="${primary} mt-3" data-action="clone">สร้างฉบับใหม่จากฉบับนี้เพื่อแก้ไข</button>`
      }
    </section>`
  }

  const draw = () =>
    render(
      el,
      html`<a href="#/courses/${courseId}/rubrics" class="text-sm text-brand-700 hover:underline">← Rubric ของหลักสูตร</a>
        <div class="mt-3">${pageHeader(instrument.title, `${instrument.code} · ${course.title}`)}</div>
        ${
          instrument.status === 'archived'
            ? html`<div class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-archived>
                <span>Rubric นี้เก็บถาวรแล้ว (ไม่ถูกเสนอเมื่อสร้างภาระงานใหม่) ผลที่ให้ไปแล้วยังอยู่ครบ</span>
                <button type="button" class="${secondary}" data-action="unarchive">นำกลับมาใช้</button>
              </div>`
            : ''
        }
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}
        <div class="space-y-4">
          ${versionBar()} ${statusPanel()}
          <ol class="space-y-3" data-criteria>${criteria.map(criterionCard)}</ol>
          ${
            isDraft()
              ? editing && !editing.criterionId
                ? criterionForm(null)
                : html`<div class="flex flex-wrap gap-2 rounded-xl border border-dashed border-ink-200 bg-white p-3">
                    <button type="button" class="${secondary}" data-action="new-criterion">+ เพิ่มเกณฑ์</button>
                  </div>`
              : ''
          }
          <section class="pt-6" data-delete-zone data-kind="instrument" data-id="${instrument.id}"></section>
        </div>`
    )

  const run = async (fn, okMessage) => {
    if (busy) return
    busy = true
    try {
      await fn()
      editing = null
      await load()
      message = okMessage
      tone = 'success'
    } catch (err) {
      message = toUserMessage(err)
      tone = 'error'
    } finally {
      busy = false
      draw()
    }
  }

  // "ลบ Rubric": unused → delete with the typed code; used → reasons + archive
  watchDeleteZones(el, {
    services,
    config: () => ({
      confirmWord: instrument.code,
      noun: 'Rubric',
      below: 'ทุกฉบับและทุกเกณฑ์ของ Rubric นี้',
      archive:
        instrument.status === 'archived'
          ? null
          : {
              label: 'เก็บถาวร Rubric',
              run: () =>
                run(
                  () => services.quizzes.setInstrumentStatus(instrument.id, 'archived'),
                  'เก็บถาวร Rubric แล้ว'
                ),
            },
      onDeleted: () => navigate(`/courses/${courseId}/rubrics`),
    }),
  })

  const saveCriterion = async (form) => {
    const f = new FormData(form)
    const ids = f.getAll('level_id').map(String)
    const labels = f.getAll('level_label').map(String)
    const scores = f.getAll('level_score').map(String)
    const descriptions = f.getAll('level_description').map(String)
    const { item } = buildCriterionDraft({
      prompt: f.get('prompt'),
      description: f.get('description'),
      levels: ids.map((id, i) => ({ id, label: labels[i], score: scores[i], description: descriptions[i] })),
    })
    if (editing.criterionId) await services.quizzes.updateItem(editing.criterionId, item)
    else await services.quizzes.addItem(version.id, item, nextOrder(criteria))
  }

  el.onclick = (e) => {
    const b = e.target.closest('button[data-action]')
    if (!b || b.disabled) return
    const { action, id: targetId, delta } = b.dataset
    switch (action) {
      case 'select-version':
        selectedVersionId = targetId
        editing = null
        message = null
        return run(async () => {}, null)
      case 'new-criterion':
        editing = { criterionId: null }
        message = null
        return draw()
      case 'edit-criterion':
        editing = { criterionId: targetId }
        message = null
        return draw()
      case 'cancel-criterion':
        editing = null
        return draw()
      case 'add-level': {
        const form = b.closest('form')
        const box = form.querySelector('[data-levels]')
        const used = [...box.querySelectorAll('input[name=level_id]')].map((i) => i.value)
        if (used.length >= MAX_LEVELS) {
          return render(
            form.querySelector('[data-form-error]'),
            alertBox(`เกณฑ์มีได้ไม่เกิน ${MAX_LEVELS} ระดับ`)
          )
        }
        // Append one row without re-rendering the form (keeps what is typed).
        const holder = document.createElement('div')
        render(holder, levelRow({ id: nextLevelId(used) }))
        box.append(holder.firstElementChild)
        return undefined
      }
      case 'remove-level': {
        const form = b.closest('form')
        if (form.querySelectorAll('[data-level-row]').length <= MIN_LEVELS) {
          return render(
            form.querySelector('[data-form-error]'),
            alertBox(`เกณฑ์ต้องมีอย่างน้อย ${MIN_LEVELS} ระดับ`)
          )
        }
        b.closest('[data-level-row]').remove()
        return undefined
      }
      case 'move-criterion':
        return run(
          () =>
            services.quizzes.reorderItems(
              version.id,
              moveId(
                criteria.map((c) => c.id),
                targetId,
                Number(delta)
              )
            ),
          'จัดลำดับเกณฑ์แล้ว'
        )
      case 'unarchive':
        return run(
          () => services.quizzes.setInstrumentStatus(instrument.id, 'active'),
          'นำ Rubric กลับมาใช้แล้ว'
        )
      case 'delete-criterion':
        if (!window.confirm('ลบเกณฑ์นี้?')) return undefined
        return run(() => services.quizzes.deleteItem(targetId), 'ลบเกณฑ์แล้ว')
      case 'publish':
        if (!window.confirm('เผยแพร่ฉบับนี้? เมื่อเผยแพร่แล้วจะแก้ไขเกณฑ์ของฉบับนี้ไม่ได้อีก'))
          return undefined
        return run(async () => {
          await services.quizzes.publish(version.id)
          selectedVersionId = version.id
        }, 'เผยแพร่แล้ว — นำไปใช้กับภาระงานได้')
      case 'clone':
        return run(async () => {
          selectedVersionId = await services.quizzes.clone(version.id)
        }, 'สร้างฉบับร่างใหม่แล้ว (คัดลอกเกณฑ์จากฉบับเดิม)')
    }
    return undefined
  }

  el.onsubmit = (e) => {
    e.preventDefault()
    const form = e.target
    if (form.dataset.form !== 'criterion' || busy) return
    busy = true
    const errorSlot = form.querySelector('[data-form-error]')
    saveCriterion(form).then(
      () => {
        busy = false
        run(async () => {}, 'บันทึกเกณฑ์แล้ว')
      },
      (err) => {
        // Keep the open form (and what the author typed); show the error inside it.
        busy = false
        render(errorSlot, alertBox(toUserMessage(err)))
      }
    )
  }

  draw()
}
