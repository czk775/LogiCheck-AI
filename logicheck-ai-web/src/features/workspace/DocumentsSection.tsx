import { Icon } from '../../components/Icon'
import { Chip } from '../../components/Chip'
import { useStore } from '../../store/AppStore'
import { docStatusMeta } from '../../services/domain/shipmentStatus'
import { UploadZone } from './UploadZone'
import { useFileChooser } from '../layout/AppShell'
import { formatFileSize } from '../../utils/format'
import type { ShipmentDocument } from '../../types/domain'

/** 单证管理区块 —— 与原型 docs 区块一致 */
export function DocumentsSection() {
  const { activeShipment, openDrawer, openModal, retryDocument } = useStore()
  const chooser = useFileChooser()
  const s = activeShipment!
  const hasDocs = s.documents.length > 0
  const processing = s.documents.some((d) => d.status === 'uploading' || d.status === 'parsing')

  return (
    <section id="docs" className="glass-panel section-card">
      <div className="section-title">
        <h2>单证管理</h2>
        <button type="button" className="section-link" onClick={() => chooser.open({ kind: 'add' })}>
          添加单证 <Icon name="arrow" size="sm" />
        </button>
      </div>

      {hasDocs ? (
        <div>
          {s.documents.map((d) => (
            <DocumentRow
              key={d.id}
              doc={d}
              onPreview={() => openDrawer({ type: 'document', documentId: d.id })}
              onDelete={() => openModal({ type: 'delete-document', documentId: d.id })}
              onRetry={() => void retryDocument(d.id)}
            />
          ))}
        </div>
      ) : (
        <UploadZone />
      )}

      {hasDocs ? (
        <div style={{ marginTop: 17 }}>
          <UploadZone />
        </div>
      ) : null}

      {processing ? (
        <div style={{ marginTop: 13 }} data-testid="upload-progress">
          <Icon name="activity" size="sm" />{' '}
          <span style={{ color: 'var(--soft)', fontSize: 11 }}>正在接收文件…</span>
          <div className="shimmer" style={{ marginTop: 10 }} />
        </div>
      ) : null}
    </section>
  )
}

function DocumentRow({
  doc: d,
  onPreview,
  onDelete,
  onRetry,
}: {
  doc: ShipmentDocument
  onPreview: () => void
  onDelete: () => void
  onRetry: () => void
}) {
  const meta = docStatusMeta(d)
  return (
    <div className="sub-row" data-testid="doc-row" data-file-name={d.fileName}>
      <div className="doc-icon">
        <Icon name={d.format === 'edi' ? 'clipboard' : 'file'} />
      </div>
      <div className="doc-info">
        <strong title={d.fileName}>{d.fileName}</strong>
        <span>
          {d.docType || '待识别单证类型'} · {d.isDemo ? '演示来源' : `用户本地文件 · ${formatFileSize(d.size)}`}
          {d.error ? ` · ${d.error}` : ''}
        </span>
      </div>
      <div className="doc-actions">
        <Chip label={meta.label} tone={meta.tone} />
        <button type="button" className="link-btn" onClick={onPreview} title="预览文件" aria-label="预览文件">
          <Icon name="eye" size="sm" />
        </button>
        {d.status === 'failed' ? (
          <button type="button" className="link-btn" onClick={onRetry} data-testid="retry-doc">
            重试
          </button>
        ) : null}
        <button
          type="button"
          className="link-btn"
          onClick={onDelete}
          title="移除单证"
          aria-label="移除单证"
          data-testid="delete-doc"
        >
          <Icon name="trash" size="sm" />
        </button>
      </div>
    </div>
  )
}
