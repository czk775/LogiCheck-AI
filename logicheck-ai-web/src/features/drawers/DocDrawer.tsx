import { Chip } from '../../components/Chip'
import { Drawer } from '../../components/Drawer'
import { useStore } from '../../store/AppStore'
import { docStatusMeta } from '../../services/domain/shipmentStatus'
import { apiMode } from '../../services/api'
import { describeExtractionSource } from '../../services/domain/aiStatus'
import { EvidencePreview } from '../workspace/EvidencePreview'
import { formatFileSize, formatTime } from '../../utils/format'
import type { ShipmentDocument } from '../../types/domain'

/** 单证预览抽屉（窄）—— 与原型 docDrawer 一致 */
export function DocDrawer({ doc }: { doc: ShipmentDocument }) {
  const { closeDrawer } = useStore()
  const meta = docStatusMeta(doc)
  const real = apiMode === 'real'

  return (
    <Drawer
      title={doc.fileName}
      subtitle={`${doc.docType} · ${doc.isDemo ? '演示样例' : real ? '本机服务器上传文件' : '浏览器本地上传文件'}`}
      onClose={closeDrawer}
      testId="doc-drawer"
    >
      <div className="mini-toolbar">
        <Chip label={meta.label} tone={meta.tone} />
        <span>
          {doc.isDemo
            ? '模拟单证字段排版'
            : real
              ? `原件预览 · ${formatFileSize(doc.size)}`
              : `原件预览（未 AI 解析） · ${formatFileSize(doc.size)}`}
        </span>
      </div>
      {real && doc.status === 'failed' && doc.error ? (
        <p className="text-note" style={{ marginTop: 10, color: 'var(--color-danger, #c0392b)' }}>
          处理失败原因：{doc.error}
        </p>
      ) : null}
      {real && doc.parseSummary ? <p className="text-note" style={{ marginTop: 10 }}>解析摘要：{doc.parseSummary}</p> : null}
      <EvidencePreview doc={doc} />
      <div className="prototype-note" style={{ marginTop: 17 }}>
        {doc.isDemo
          ? '这是专为 UI 评审制作的模拟单证，不是 PDF 原件。'
          : real
            ? '这是用户真实上传的文件预览；' + describeExtractionSource(doc.extractionProvider, doc.extractionModel)
            : '这是用户真实上传的文件预览，不包含虚构的识别字段；真实 AI 解析留待后端集成。'}
      </div>
      <p className="text-note" style={{ marginTop: 12 }}>
        上传于 {formatTime(doc.createdAt)}
      </p>
    </Drawer>
  )
}
