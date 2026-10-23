import { useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { useFileChooser } from '../layout/AppShell'

/** 拖拽 / 点击上传区 —— 与原型 upload-zone 一致 */
export function UploadZone() {
  const chooser = useFileChooser()
  const [drag, setDrag] = useState(false)
  const dragDepth = useRef(0)

  const open = () => chooser.open({ kind: 'add' })

  return (
    <div
      className={`upload-zone ${drag ? 'drag' : ''}`}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
      onDragEnter={(e) => {
        e.preventDefault()
        dragDepth.current += 1
        setDrag(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        dragDepth.current -= 1
        if (dragDepth.current <= 0) setDrag(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        dragDepth.current = 0
        setDrag(false)
        // 走全局选择器同一条通道，保证「补充上传」语义一致
        chooser.open({ kind: 'add' })
      }}
      data-testid="upload-zone"
      aria-label="上传单证：拖拽文件到这里，或点击上传"
    >
      <Icon name="cloud" size="xl" />
      <strong>拖拽文件到这里，或点击上传</strong>
      <span>PDF · JPG / PNG · EDIFACT (EDI / TXT) · 可多选</span>
    </div>
  )
}
