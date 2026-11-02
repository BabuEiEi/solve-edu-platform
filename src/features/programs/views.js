import { html, render } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, statusBadge, loading } from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { formatThaiDate } from '../../shared/utils/date.js'

export async function renderProgramsView(el, { services }) {
  render(el, html`${pageHeader('โครงการและรุ่น')}${loading}`)
  try {
    const programs = await services.programs.listVisiblePrograms()
    render(
      el,
      html`
        ${pageHeader('โครงการและรุ่น', 'โครงการที่ท่านบริหารหรือเข้าร่วม')}
        ${
          programs.length === 0
            ? emptyState('ยังไม่มีโครงการที่ท่านเข้าถึงได้')
            : html`<div class="space-y-4">
                ${programs.map(
                  (p) =>
                    html`<article class="rounded-xl border border-ink-200 bg-white p-6">
                      <div class="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p class="text-xs font-semibold uppercase tracking-wide text-brand-600">
                            ปีงบประมาณ ${p.fiscal_year} · ${p.code}
                          </p>
                          <h2 class="mt-1 text-lg font-semibold text-ink-900">${p.name}</h2>
                          <p class="text-sm text-ink-500">${p.organizations?.name ?? ''}</p>
                        </div>
                        ${statusBadge(p.status)}
                      </div>
                      ${p.description ? html`<p class="mt-3 text-sm text-ink-600">${p.description}</p>` : ''}
                      <ul class="mt-4 divide-y divide-ink-100 rounded-lg border border-ink-100">
                        ${(p.cohorts ?? []).map(
                          (c) =>
                            html`<li
                              class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
                            >
                              <span class="font-medium text-ink-800"
                                >${c.name} <span class="text-ink-400">(${c.code})</span></span
                              >
                              <span class="flex items-center gap-3 text-ink-500"
                                >${formatThaiDate(c.start_at)} – ${formatThaiDate(c.end_at)}
                                ${statusBadge(c.status)}</span
                              >
                            </li>`
                        )}
                      </ul>
                    </article>`
                )}
              </div>`
        }
      `
    )
  } catch (err) {
    render(el, html`${pageHeader('โครงการและรุ่น')}${alertBox(toUserMessage(err))}`)
  }
}
