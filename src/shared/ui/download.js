/** Save text as a file through a short-lived blob: URL (no server round trip). */
export function downloadText(filename, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
