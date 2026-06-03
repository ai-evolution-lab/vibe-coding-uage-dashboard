export function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0)
}

export function formatCompact(value: number, digits = 1) {
  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0)
}

export function formatPercent(value: number) {
  return `${formatNumber(value * 100, 1)}%`
}

export function formatCurrency(value: number) {
  return `$${formatNumber(value, 2)}`
}

export function splitDisplayValue(value: string) {
  const normalized = value.trim()
  const match = normalized.match(/^([^0-9-]*)(-?[0-9][0-9,.]*)(.*)$/u)
  if (!match) {
    return {
      prefix: '',
      primary: normalized,
      unit: '',
    }
  }

  return {
    prefix: match[1].trim(),
    primary: match[2].trim(),
    unit: match[3].trim(),
  }
}

export function formatDateTime(timestampMs: number) {
  if (!timestampMs) {
    return '-'
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestampMs)
}

export function formatDate(timestampMs: number) {
  if (!timestampMs) {
    return '-'
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  }).format(timestampMs)
}

export function formatDuration(durationMs: number) {
  if (!durationMs || durationMs < 1000) {
    return '<1s'
  }

  const totalSeconds = Math.round(durationMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}

export function trimText(value: string, maxLength: number) {
  if (!value) {
    return ''
  }
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

export function compactPath(value: string, maxLength = 42) {
  if (!value || value.length <= maxLength) {
    return value
  }
  const parts = value.split('/').filter(Boolean)
  if (parts.length <= 2) {
    return trimText(value, maxLength)
  }
  const tail = parts.slice(-2).join('/')
  const head = value.startsWith('/') ? `/${parts[0]}` : parts[0]
  const compact = `${head}/.../${tail}`
  return compact.length <= maxLength ? compact : trimText(compact, maxLength)
}

export function slugifyDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}${month}${day}-${hour}${minute}`
}
