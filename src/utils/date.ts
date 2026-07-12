export function formatDate(timestamp: number) {
  if (!timestamp) return '未知'
  const date = new Date(timestamp * 1000)
  const pad = (value: number) => value.toString().padStart(2, '0')
  return [
    date.getFullYear(),
    '/',
    pad(date.getMonth() + 1),
    '/',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('')
}
