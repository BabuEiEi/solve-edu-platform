import { html, render } from '../../shared/ui/html.js'
import { centeredCard } from '../../shared/ui/layout.js'
import { alertBox, pageHeader, statusBadge, roleChip, loading } from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'

const input =
  'mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const primaryBtn =
  'inline-flex w-full items-center justify-center rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-60'

// ---------------------------------------------------------------- login / sign-up
export function renderAuthScreen(root, { auth }) {
  let mode = 'signin'
  const draw = (message = null, tone = 'error') => {
    const signup = mode === 'signup'
    render(
      root,
      centeredCard(html`
        <p class="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">
          SolveEdu Integrated Platform
        </p>
        <h1 class="mt-2 text-xl font-semibold text-ink-900">${signup ? 'สมัครใช้งาน' : 'เข้าสู่ระบบ'}</h1>
        <p class="mt-1 text-sm text-ink-500">ระบบพัฒนาครู ประเมินสมรรถนะ และนิเทศติดตาม</p>
        <div class="mt-6">${message ? alertBox(message, tone) : ''}</div>
        <form data-form="auth" class="mt-4 space-y-4" novalidate>
          ${
            signup
              ? html`<label class="block text-sm font-medium text-ink-700"
                  >ชื่อ–นามสกุล<input
                    name="full_name"
                    required
                    maxlength="200"
                    autocomplete="name"
                    class="${input}"
                /></label>`
              : ''
          }
          <label class="block text-sm font-medium text-ink-700"
            >อีเมล<input name="email" type="email" required autocomplete="email" class="${input}"
          /></label>
          <label class="block text-sm font-medium text-ink-700"
            >รหัสผ่าน<input
              name="password"
              type="password"
              required
              minlength="8"
              autocomplete="${signup ? 'new-password' : 'current-password'}"
              class="${input}"
          /></label>
          <button class="${primaryBtn}" type="submit">${signup ? 'สมัครใช้งาน' : 'เข้าสู่ระบบ'}</button>
        </form>
        <div class="my-5 flex items-center gap-3 text-xs text-ink-400">
          <span class="h-px flex-1 bg-ink-200"></span>หรือ<span class="h-px flex-1 bg-ink-200"></span>
        </div>
        <button
          data-action="google"
          class="w-full rounded-lg border border-ink-200 px-4 py-2.5 text-sm font-medium text-ink-700 hover:bg-ink-50"
        >
          เข้าสู่ระบบด้วย Google
        </button>
        <p class="mt-6 text-center text-sm text-ink-500">
          ${signup ? 'มีบัญชีแล้ว?' : 'ยังไม่มีบัญชี?'}
          <button data-action="toggle" class="font-semibold text-brand-700 hover:underline">
            ${signup ? 'เข้าสู่ระบบ' : 'สมัครใช้งาน'}
          </button>
        </p>
        <p class="mt-4 text-center text-xs text-ink-400">
          การสมัครหรือเข้าสู่ระบบ ถือว่าท่านได้อ่าน
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer" class="underline hover:text-ink-600" data-privacy-link
            >นโยบายความเป็นส่วนตัว</a
          >
        </p>
      `)
    )
  }

  root.onclick = async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action
    if (action === 'toggle') {
      mode = mode === 'signin' ? 'signup' : 'signin'
      draw()
    } else if (action === 'google') {
      try {
        await auth.signInWithGoogle()
      } catch (err) {
        draw(`${toUserMessage(err)} (ตรวจสอบว่าได้เปิดใช้ Google OAuth แล้ว)`)
      }
    }
  }
  root.onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    const btn = e.target.querySelector('button[type=submit]')
    btn.disabled = true
    try {
      if (mode === 'signup') {
        const res = await auth.signUp(f.get('email'), f.get('password'), f.get('full_name'))
        if (!res?.session) draw('สมัครสำเร็จ กรุณายืนยันอีเมลแล้วเข้าสู่ระบบ', 'success')
      } else {
        await auth.signInWithPassword(f.get('email'), f.get('password'))
      }
    } catch (err) {
      draw(toUserMessage(err))
    }
  }
  draw()
}

// ---------------------------------------------------------------- pending / suspended
export async function renderPendingScreen(root, { context, services, auth, refresh }) {
  const { profile } = context
  render(root, centeredCard(loading))
  let orgs = []
  let message = null
  try {
    orgs = await services.organizations.listActiveOrganizations({ orgType: 'school' })
  } catch (err) {
    message = toUserMessage(err)
  }
  const draw = (msg = message, tone = 'error') =>
    render(
      root,
      centeredCard(html`
        <div class="flex items-center justify-between">
          <h1 class="text-xl font-semibold text-ink-900">บัญชีรอการอนุมัติ</h1>
          ${statusBadge(profile.status)}
        </div>
        <p class="mt-3 text-sm leading-relaxed text-ink-600">
          สวัสดี ${profile.full_name || 'ผู้ใช้งานใหม่'} —
          ผู้บริหารสถานศึกษาหรือผู้ดูแลเขตพื้นที่จะตรวจสอบและอนุมัติบัญชีของท่าน
          กรุณาเลือกสถานศึกษาที่สังกัดเพื่อส่งคำขอไปยังผู้อนุมัติที่ถูกต้อง
        </p>
        <div class="mt-4">${msg ? alertBox(msg, tone) : ''}</div>
        <form data-form="requested-org" class="mt-4 space-y-3">
          <label class="block text-sm font-medium text-ink-700"
            >สถานศึกษาที่สังกัด
            <select name="org" required class="${input}">
              <option value="">— เลือกสถานศึกษา —</option>
              ${orgs.map(
                (o) =>
                  html`<option value="${o.id}" ${o.id === profile.requested_org_id ? 'selected' : ''}>
                    ${o.name}
                  </option>`
              )}
            </select>
          </label>
          <button class="${primaryBtn}" type="submit">บันทึกคำขอ</button>
        </form>
        <button data-action="sign-out" class="mt-4 w-full text-sm text-ink-500 hover:text-ink-800">
          ออกจากระบบ
        </button>
      `)
    )
  root.onsubmit = async (e) => {
    e.preventDefault()
    const orgId = new FormData(e.target).get('org')
    try {
      const updated = await services.profiles.setRequestedOrganization(profile.id, orgId)
      Object.assign(profile, updated)
      draw('บันทึกคำขอแล้ว กรุณารอการอนุมัติ', 'success')
    } catch (err) {
      draw(toUserMessage(err))
    }
  }
  root.onclick = async (e) => {
    if (e.target.closest('[data-action="sign-out"]')) {
      await auth.signOut()
      refresh()
    }
  }
  draw()
}

export function renderDeletedScreen(root, { auth, refresh }) {
  render(
    root,
    centeredCard(html`
      <h1 class="text-xl font-semibold text-ink-900">บัญชีนี้ถูกลบแล้ว</h1>
      <p class="mt-3 text-sm text-ink-600">ข้อมูลส่วนตัวของบัญชีนี้ถูกลบตามคำขอแล้ว หากต้องการใช้งานอีกครั้ง กรุณาสมัครใหม่</p>
      <button data-action="sign-out" class="${primaryBtn} mt-6">ออกจากระบบ</button>
    `)
  )
  root.onclick = async (e) => {
    if (e.target.closest('[data-action="sign-out"]')) {
      await auth.signOut()
      refresh()
    }
  }
}

export function renderSuspendedScreen(root, { auth, refresh }) {
  render(
    root,
    centeredCard(html`
      <h1 class="text-xl font-semibold text-ink-900">บัญชีถูกระงับการใช้งาน</h1>
      <p class="mt-3 text-sm text-ink-600">กรุณาติดต่อผู้ดูแลเขตพื้นที่หรือผู้บริหารสถานศึกษาของท่าน</p>
      <button data-action="sign-out" class="${primaryBtn} mt-6">ออกจากระบบ</button>
    `)
  )
  root.onclick = async (e) => {
    if (e.target.closest('[data-action="sign-out"]')) {
      await auth.signOut()
      refresh()
    }
  }
}

// ---------------------------------------------------------------- my profile
export async function renderProfileView(el, { context, services, session }) {
  const { profile } = context
  let email = session.user.email
  const draw = (msg = null, tone = 'success') =>
    render(
      el,
      html`
        ${pageHeader('โปรไฟล์ของฉัน', 'ข้อมูลส่วนบุคคลแก้ไขได้เฉพาะชื่อที่แสดง บทบาทกำหนดโดยผู้ดูแลตามขอบเขตสิทธิ์')}
        <div class="grid gap-6 lg:grid-cols-[1fr_320px]">
          <form data-form="profile" class="space-y-4 rounded-xl border border-ink-200 bg-white p-6">
            ${msg ? alertBox(msg, tone) : ''}
            <label class="block text-sm font-medium text-ink-700"
              >ชื่อ–นามสกุล<input
                name="full_name"
                value="${profile.full_name}"
                maxlength="200"
                required
                class="${input}"
            /></label>
            <label class="block text-sm font-medium text-ink-700"
              >ชื่อที่แสดง<input
                name="display_name"
                value="${profile.display_name ?? ''}"
                maxlength="100"
                class="${input}"
            /></label>
            <p class="text-sm text-ink-500">
              อีเมลสำหรับติดต่อ: <span class="font-medium text-ink-800">${email}</span>
            </p>
            <button class="${primaryBtn} sm:w-auto" type="submit">บันทึก</button>
          </form>
          <section class="space-y-4 rounded-xl border border-ink-200 bg-white p-6 text-sm">
            <div class="flex items-center justify-between">
              <span class="text-ink-500">สถานะบัญชี</span>${statusBadge(profile.status)}
            </div>
            <div>
              <p class="text-ink-500">สังกัดและบทบาท</p>
              <ul class="mt-2 space-y-2">
                ${
                  context.orgMemberships.length
                    ? context.orgMemberships.map(
                        (m) =>
                          html`<li class="flex flex-wrap items-center gap-2">
                            ${roleChip(m.org_role)}<span class="text-ink-700"
                              >${m.organizations?.name ?? '—'}</span
                            >
                          </li>`
                      )
                    : html`<li class="text-ink-400">ยังไม่มีบทบาทในหน่วยงาน</li>`
                }
              </ul>
            </div>
            <p class="text-xs text-ink-400">ปรับปรุงล่าสุด ${formatThaiDateTime(profile.updated_at)}</p>
          </section>
        </div>
      `
    )
  el.onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    try {
      Object.assign(
        profile,
        await services.profiles.updateMyProfile(profile.id, {
          full_name: f.get('full_name'),
          display_name: f.get('display_name'),
        })
      )
      draw('บันทึกข้อมูลแล้ว')
    } catch (err) {
      draw(toUserMessage(err), 'error')
    }
  }
  draw()
}
