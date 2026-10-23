import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icon'
import { useEscapeKey } from './Toast'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  /** 底部操作区（按钮组） */
  actions?: ReactNode
  testId?: string
}

/** 居中对话框 —— 与原型 dialog 组件一致（overlay 点击 / Esc / 右上角关闭均可关闭） */
export function Modal({ title, onClose, children, actions, testId }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useEscapeKey(true, onClose)

  useEffect(() => {
    // 打开时将焦点移入对话框，保证键盘用户可感知
    dialogRef.current?.focus()
  }, [])

  return (
    <>
      <div className="overlay" onClick={onClose} data-testid="modal-overlay" />
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
        tabIndex={-1}
        data-testid={testId ?? 'modal'}
      >
        <div className="dialog-header">
          <h2>{title}</h2>
          <button type="button" className="close" onClick={onClose} title="关闭" aria-label="关闭对话框">
            <Icon name="x" />
          </button>
        </div>
        {children}
        {actions ? <div className="dialog-actions">{actions}</div> : null}
      </div>
    </>
  )
}
