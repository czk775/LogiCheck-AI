/** 与原型 formatTime 一致 */
export function formatTime(x?: string): string {
  if (!x) return '刚刚'
  return new Date(x).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 平滑滚动到工作台区块并高亮一闪（与原型 scrollToSection 一致） */
export function scrollToSection(id: string): void {
  const el = document.getElementById(id)
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (el) {
    el.style.borderColor = '#4c9099'
    setTimeout(() => {
      el.style.borderColor = ''
    }, 1000)
  }
}

export function formatFileSize(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
