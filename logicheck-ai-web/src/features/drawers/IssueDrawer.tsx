import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { Drawer } from '../../components/Drawer'
import { useStore } from '../../store/AppStore'
import { useToast } from '../../components/Toast'
import { useFileChooser } from '../layout/AppShell'
import { EvidencePreview } from '../workspace/EvidencePreview'
import { isEngineMode } from '../../services/domain/runMode'
import { formatTime } from '../../utils/format'
import type { Finding, Shipment } from '../../types/domain'

/** 异常详情抽屉（宽）—— 与原型 issueDrawer 一致：证据 / 判断 / 行动 / 记录 */
export function IssueDrawer({ shipment, finding }: { shipment: Shipment; finding: Finding }) {
  const { state, closeDrawer, selectEvidence, openModal, recheck } = useStore()
  const { push } = useToast()
  const chooser = useFileChooser()
  // 引擎模式 = 真实后端 + 非演示货物（演示货物在真实后端上仍是 seed 数据）
  const engine = isEngineMode(shipment)

  const evidence = finding.evidence
    .map((id) => shipment.documents.find((d) => d.id === id))
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
  const current = evidence.find((d) => d.id === state.selectedEvidenceId) ?? evidence[0]
  const isQty = finding.kind === 'cross'
  const inv = shipment.documents.find((d) => d.id === 'doc-invoice')
  const pl = shipment.documents.find((d) => d.id === 'doc-packing')

  // 引擎模式：对比单元格直接取证据单证的实际字段值（演示货物沿用原型固定文档）
  const compareDocs = engine
    ? evidence.slice(0, 2)
    : [inv, pl].filter((d): d is NonNullable<typeof d> => Boolean(d))
  const compareUnit = engine ? '' : 'PCS'

  const onReplace = () => {
    const source =
      (state.selectedEvidenceId && shipment.documents.some((d) => d.id === state.selectedEvidenceId)
        ? state.selectedEvidenceId
        : null) ??
      finding.evidence.find((id) => shipment.documents.some((d) => d.id === id))
    if (!source) {
      push('暂无来源单证，请使用补充单证', 'error')
      chooser.open({ kind: 'add' })
      return
    }
    chooser.open({ kind: 'replace', documentId: source })
  }

  // 修正按钮：演示货物沿用原型约定（装箱单）；引擎模式指向当前查看的证据单证
  const fixTargetDocId = engine ? (current?.id ?? evidence[0]?.id) : 'doc-packing'

  return (
    <Drawer
      title={finding.title}
      subtitle="异常详情 / 原始证据 / 人工复核"
      wide
      onClose={closeDrawer}
      testId="issue-drawer"
    >
      <div className="evidence-split">
        <div className="evidence-side">
          <div className="mini-toolbar">
            <div className="detail-label" style={{ margin: 0 }}>
              原始证据
            </div>
            <span>{engine ? '服务器原件' : '演示数据 · 非原始 PDF'}</span>
          </div>
          {evidence.length ? (
            <div className="evidence-tabs">
              {evidence.map((d) => (
                <button
                  type="button"
                  key={d.id}
                  className={current?.id === d.id ? 'active' : ''}
                  onClick={() => selectEvidence(d.id)}
                  data-testid="evidence-tab"
                >
                  {d.fileName}
                </button>
              ))}
            </div>
          ) : null}
          <EvidencePreview doc={current ?? null} highlight={isQty ? 'quantity' : 'hs'} />
          <p className="text-note">
            {current
              ? engine
                ? '当前显示的是服务器上保存的原始单证文件。'
                : '当前标记的字段行来自演示结构化数据。正式版仅在真实页码、区域可用时高亮。'
              : '该异常缺少对应原始证据，请补充文件。'}
          </p>
        </div>

        <div className="evidence-side">
          <div className="detail-label">异常判断</div>
          <Chip
            label={finding.status === 'resolved' ? '已解决' : finding.status === 'reviewed' ? '人工已复核 · 风险保留' : '待处理'}
            tone={finding.status === 'resolved' ? 'good' : 'warn'}
          />
          <p className="detail-paragraph">{finding.summary}</p>
          {isQty && compareDocs.length ? (
            <div className="big-compare">
              {compareDocs.map((d) => (
                <div className="compare-cell" key={d.id}>
                  <span>{d.fileName}</span>
                  <strong>{d.fields.quantity ?? '—'}</strong> {compareUnit ? <small>{compareUnit}</small> : null}
                </div>
              ))}
            </div>
          ) : null}

          <div className="detail-label" style={{ marginTop: 24 }}>
            为什么被标记
          </div>
          <p className="detail-paragraph">
            {isQty
              ? '两份来源单证的数量提取值不一致。系统不会自动选择哪个值正确。需要检查原文并判断是识别错误还是真实单证冲突。'
              : finding.ruleKey === 'red'
                ? '尚未确认适用的欧盟符合性声明材料，请补充并人工核查。'
                : '现有数据不足以完成准确的税则归类，需要人工确认。'}
          </p>

          <div className="detail-label">下一步建议</div>
          <div className="detail-list">
            <div>① 核对上方原始证据、文件类型及字段值。</div>
            <div>② AI 识别错误时修正提取值；原文件确有错误时替换单证。</div>
            <div>③ 保存人工意见，再重新检查受影响的规则。</div>
          </div>

          <div style={{ marginTop: 24, display: 'flex', flexWrap: 'wrap', gap: 9 }}>
            {isQty && fixTargetDocId ? (
              <Button
                icon="edit"
                onClick={() => openModal({ type: 'field-edit', fieldKey: 'quantity', sourceDocumentId: fixTargetDocId })}
                data-testid="fix-extraction"
              >
                修正 AI 提取
              </Button>
            ) : null}
            <Button icon="upload" onClick={onReplace} data-testid="replace-document">
              替换单证
            </Button>
            <Button icon="clipboard" onClick={() => openModal({ type: 'review', findingId: finding.id })} data-testid="add-review">
              人工复核
            </Button>
            <Button variant="primary" icon="refresh" onClick={() => void recheck()} data-testid="recheck-in-drawer">
              重新检查
            </Button>
          </div>

          <div className="small-divider" />
          <div className="detail-label">处理记录</div>
          {finding.notes.length ? (
            finding.notes.map((n) => (
              <div className="activity-entry" key={n.id}>
                <strong>{n.text}</strong>
                <small>
                  {formatTime(n.at)} · 人工复核
                </small>
              </div>
            ))
          ) : (
            <p className="text-note">暂无人工处理记录</p>
          )}
          <p className="text-note">人工已复核不代表核验通过；重新检查后若冲突依然存在，异常继续保留。</p>
        </div>
      </div>
    </Drawer>
  )
}
