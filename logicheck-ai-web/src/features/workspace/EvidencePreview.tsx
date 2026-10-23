import { useEffect, useState } from 'react'
import { api } from '../../services/api'
import type { ShipmentDocument } from '../../types/domain'

/* ============================================================
   原始证据预览
   - 演示单证：模拟单证排版（明确标注非原始 PDF，仅用于交互评审）
   - 真实上传文件：iframe / img / 文本原文，不虚构任何识别字段
   ============================================================ */

/** 从 IndexedDB 读取真实文件并生成预览 URL（组件卸载时释放） */
export function useDocumentPreview(documentId: string | null, isDemo: boolean) {
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!documentId || isDemo) {
      setUrl(null)
      setText(null)
      setMissing(false)
      return
    }
    let revoked = false
    let created: string | null = null
    setLoading(true)
    setMissing(false)
    setUrl(null)
    setText(null)

    void api
      .getDocumentBlob(documentId)
      .then(async (blob) => {
        if (revoked) return
        if (!blob) {
          setMissing(true)
          setLoading(false)
          return
        }
        created = URL.createObjectURL(blob)
        setUrl(created)
        const t = await api.getDocumentText(documentId)
        if (!revoked) setText(t)
        setLoading(false)
      })
      .catch(() => {
        if (!revoked) {
          setMissing(true)
          setLoading(false)
        }
      })

    return () => {
      revoked = true
      if (created) URL.revokeObjectURL(created)
    }
  }, [documentId, isDemo])

  return { url, text, loading, missing }
}

/** 演示单证的模拟排版（与原型 documentPaper 一致） */
export function DemoDocumentPaper({ doc, highlight }: { doc: ShipmentDocument; highlight?: 'quantity' | 'hs' }) {
  if (doc.format === 'edi') {
    return (
      <pre className="edi-pre">
        {`UNB+UNOC:3+CNEXPORT+DEIMPORT+261023:0925+0001'\nUNH+1+IFTMIN:D:99B:UN'\nBGM+610+${doc.id}+9'\nFTX+AAA+++${doc.fields.model || 'Bluetooth Speaker'}'\nQTY+12:${doc.fields.quantity || '1000'}:${doc.fields.unit || 'PCS'}'\nLOC+11+${doc.fields.destination || 'DE'}'\nUNT+6+1'\nUNZ+1+0001'`}
      </pre>
    )
  }

  const rows: Array<[string, string | undefined]> = [
    ['Product', doc.fields.product],
    ['Model', doc.fields.model],
    ['Quantity', doc.fields.quantity ? `${doc.fields.quantity} ${doc.fields.unit || 'PCS'}` : undefined],
    ['Gross weight', doc.fields.gross ? `${doc.fields.gross} kg` : undefined],
    ['Origin', doc.fields.origin],
    ['Destination', doc.fields.destination],
    ['HS Code', doc.fields.hs],
    ['Battery', doc.fields.battery],
    ['Declaration', doc.fields.documentType],
  ]

  const title =
    doc.docType === '商业发票'
      ? 'COMMERCIAL INVOICE'
      : doc.docType === '装箱单'
        ? 'PACKING LIST'
        : doc.docType === '合规材料'
          ? 'DECLARATION'
          : 'SHIPPING DOCUMENT'

  return (
    <div className="document-paper">
      <div className="paper-top">
        <strong>{title}</strong>
        <small>
          {doc.fileName}
          <br />
          Demo source · Page 1
        </small>
      </div>
      <div style={{ marginTop: 16 }}>
        {rows
          .filter((r) => r[1])
          .map(([key, val]) => (
            <div
              className={`paper-kv ${(highlight === 'quantity' && key === 'Quantity') || (highlight === 'hs' && key === 'HS Code') ? 'highlight' : ''}`}
              key={key}
            >
              <span>{key}</span>
              <span className="val">{val}</span>
            </div>
          ))}
      </div>
      <div className="paper-note">仅用于交互评审的模拟单证排版（不是由真实 PDF 提取）。证据定位为演示字段行。</div>
    </div>
  )
}

interface EvidencePreviewProps {
  doc: ShipmentDocument | null
  highlight?: 'quantity' | 'hs'
}

/** 与原型 docPreviewArea 一致 */
export function EvidencePreview({ doc, highlight = 'quantity' }: EvidencePreviewProps) {
  const { url, text, loading, missing } = useDocumentPreview(doc?.id ?? null, doc?.isDemo ?? true)

  if (!doc) {
    return (
      <div className="empty">
        <h3>原始证据暂无来源</h3>
        <p>请先上传并解析对应单证。</p>
      </div>
    )
  }
  if (doc.isDemo) return <DemoDocumentPaper doc={doc} highlight={highlight} />
  if (doc.status === 'failed') {
    return <div className="prototype-note">上传失败，无法预览。请重新上传或重试。</div>
  }
  if (loading) {
    return (
      <div className="prototype-note">
        正在从浏览器本地存储读取文件…
      </div>
    )
  }
  if (missing) {
    return <div className="prototype-note">未找到本地原文件，请重新上传。</div>
  }
  if (!url) {
    return <div className="prototype-note">正在从浏览器本地存储读取文件…</div>
  }
  if (doc.format === 'image') {
    return <img className="preview-img" src={url} alt={`${doc.fileName} 原始预览`} />
  }
  if (doc.format === 'pdf') {
    return <iframe className="preview-iframe" src={`${url}#toolbar=1`} title={`${doc.fileName} PDF 原文件预览`} />
  }
  if (doc.format === 'edi') {
    return (
      <>
        <div className="prototype-note">
          {doc.fileName} · 原始 EDI / 文本格式
        </div>
        <pre className="edi-pre">{text || '正在读取原始文本…'}</pre>
      </>
    )
  }
  return <div className="prototype-note">当前浏览器不支持直接预览该类型；文件已存储在演示本地。</div>
}
