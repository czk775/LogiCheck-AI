import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/Button'
import { useToast } from '../../components/Toast'
import { api, apiMode } from '../../services/api'
import type { AiCallRecord, AiStatus, EvalReport } from '../../services/api/contracts'
import { formatTime } from '../../utils/format'

/**
 * AI 运行概览（可观测性 + 评估）
 *
 * 设计约束：
 * - 所有数字来自后端真实计量（进程内用量快照 / 真实评估运行），不写死、不估算
 * - Mock 模式如实说明「未连接真实 AI」，不伪造调用记录与评估结果
 * - 单页呈现：运行指标 + 最近调用 + 三项核心能力评估结果
 */

const REAL = apiMode === 'real'

const TASK_LABEL: Record<string, string> = {
  extraction: '字段提取',
  ocr: '视觉识别',
  eval: '能力评估',
  unknown: '未标注',
}

const pct = (n: number): string => `${Math.round(n * 100)}%`
const num = (n: number): string => n.toLocaleString('zh-CN')

function MetricCard(props: { label: string; value: string; hint: string; testId: string }) {
  return (
    <div className="ai-metric glass-panel" data-testid={props.testId}>
      <div className="ai-metric-label">{props.label}</div>
      <strong className="ai-metric-value">{props.value}</strong>
      <span className="ai-metric-hint">{props.hint}</span>
    </div>
  )
}

function CallRow({ rec }: { rec: AiCallRecord }) {
  return (
    <tr>
      <td>{formatTime(rec.at)}</td>
      <td className="ai-mono">{rec.model}</td>
      <td>{TASK_LABEL[rec.task] ?? rec.task}</td>
      <td className="ai-mono">{rec.durationMs} ms</td>
      <td>
        <span className={`ai-chip tone-${rec.status === 'ok' ? 'good' : 'danger'}`}>
          {rec.status === 'ok' ? '成功' : `失败${rec.errorCode ? ` · ${rec.errorCode}` : ''}`}
        </span>
      </td>
      <td className="ai-mono">
        {num(rec.promptTokens)} / {num(rec.completionTokens)}
      </td>
    </tr>
  )
}

export function AiOverviewPage() {
  const { push } = useToast()
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [report, setReport] = useState<EvalReport | null>(null)
  const [loading, setLoading] = useState(true)
  const pollRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, r] = await Promise.all([api.getAiStatus(), api.getAiEval()])
      setStatus(s)
      setReport(r)
    } catch (err) {
      push(err instanceof Error ? err.message : '读取 AI 运行数据失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [push])

  useEffect(() => {
    void load()
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [load])

  /* 评估运行中 → 轮询直到出结果 */
  useEffect(() => {
    if (report?.status !== 'running') return
    const timer = window.setInterval(() => {
      void api.getAiEval().then((r) => {
        if (r) setReport(r)
        if (r && r.status !== 'running' && pollRef.current) {
          window.clearInterval(pollRef.current)
          pollRef.current = null
        }
      })
    }, 2500)
    pollRef.current = timer
    return () => {
      window.clearInterval(timer)
      if (pollRef.current === timer) pollRef.current = null
    }
  }, [report?.status])

  const onRunEval = async () => {
    if (report?.status === 'running') return
    try {
      const r = await api.runAiEval()
      setReport(r)
      push('评估已开始，将真实调用大模型，完成后自动展示结果')
    } catch (err) {
      push(err instanceof Error ? err.message : '启动评估失败', 'error')
    }
  }

  const usage = status?.usage ?? null
  const running = report?.status === 'running'
  const successRate = usage && usage.calls > 0 ? usage.successCalls / usage.calls : 0

  return (
    <section className="page ai-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">AI OBSERVABILITY &amp; EVALUATION</div>
          <h1>AI 运行概览</h1>
          <p className="page-sub">真实的大模型调用指标与固定样本集上的能力评估结果。</p>
        </div>
        <div className="actions">
          <Button variant="ghost" icon="refresh" onClick={() => void load()} disabled={loading}>
            刷新数据
          </Button>
          <Button
            variant="primary"
            icon="bolt"
            onClick={() => void onRunEval()}
            disabled={!REAL || running}
            data-testid="run-ai-eval"
          >
            {running ? '评估运行中…' : '运行评估'}
          </Button>
        </div>
      </div>

      {!REAL ? (
        <div className="ai-banner" data-testid="ai-overview-mock">
          <Icon name="info" size="sm" />
          当前为前端演示模式（Mock）：未连接真实大模型，没有调用记录，也无法运行真实评估。
        </div>
      ) : null}

      {/* ---------- 运行指标 ---------- */}
      <div className="section-title">
        <h2>运行指标</h2>
        <span className="section-hint">本服务进程启动以来的真实累计值</span>
      </div>
      <div className="ai-metrics">
        <MetricCard
          label="AI 调用次数"
          value={usage ? num(usage.calls) : '—'}
          hint={usage ? `成功 ${num(usage.successCalls)} · 失败 ${num(usage.failedCalls)}` : '暂无数据'}
          testId="ai-metric-calls"
        />
        <MetricCard
          label="调用成功率"
          value={usage && usage.calls > 0 ? pct(successRate) : '—'}
          hint={usage && usage.calls > 0 ? `${num(usage.successCalls)} / ${num(usage.calls)}` : '暂无数据'}
          testId="ai-metric-success"
        />
        <MetricCard
          label="平均响应耗时"
          value={usage && usage.calls > 0 ? `${num(usage.avgDurationMs)} ms` : '—'}
          hint={usage && usage.calls > 0 ? '含内部重试的端到端耗时' : '暂无数据'}
          testId="ai-metric-latency"
        />
        <MetricCard
          label="Token 消耗量"
          value={usage ? num(usage.totalTokens) : '—'}
          hint={
            usage
              ? `输入 ${num(usage.promptTokens)} · 输出 ${num(usage.completionTokens)} · 进程上限 ${num(usage.limitTokens)}`
              : '暂无数据'
          }
          testId="ai-metric-tokens"
        />
      </div>

      {/* ---------- 最近调用记录 ---------- */}
      <div className="section-title">
        <h2>最近调用记录</h2>
        <span className="section-hint">时间 · 模型 · 任务类型 · 耗时 · 状态</span>
      </div>
      {usage && usage.recent.length > 0 ? (
        <div className="table-wrap">
          <table className="ship-table ai-calls-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>模型</th>
                <th>任务类型</th>
                <th>耗时</th>
                <th>状态</th>
                <th>Token（入/出）</th>
              </tr>
            </thead>
            <tbody>
              {usage.recent.map((rec, i) => (
                <CallRow key={`${rec.at}-${i}`} rec={rec} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="ai-empty glass-panel" data-testid="ai-calls-empty">
          <Icon name="activity" />
          <p>{REAL ? '本进程还没有 AI 调用记录。上传单证触发解析，或运行一次评估后即可看到。' : '演示模式无调用记录。'}</p>
        </div>
      )}

      {/* ---------- 能力评估 ---------- */}
      <div className="section-title">
        <h2>能力评估</h2>
        <span className="section-hint">
          {report && report.status === 'done'
            ? `样本 ${num(report.samples)} 项 · 评估于 ${formatTime(report.startedAt)}${report.durationMs ? ` · 耗时 ${(report.durationMs / 1000).toFixed(1)}s` : ''}`
            : '基于固定 UAT 单证与标准答案的真实运行'}
        </span>
      </div>

      {report === null ? (
        <div className="ai-empty glass-panel" data-testid="ai-eval-empty">
          <Icon name="bolt" />
          <p>尚未运行过评估。点击「运行评估」将用固定样本集真实调用大模型，产出三项核心能力结果。</p>
        </div>
      ) : report.status === 'error' ? (
        <div className="ai-banner tone-danger" data-testid="ai-eval-error">
          <Icon name="alert" size="sm" />
          评估失败：{report.error ?? '未知错误'}
        </div>
      ) : (
        <div className="ai-eval-grid">
          {/* 1. 字段提取准确率 */}
          <div className="ai-eval-card glass-panel" data-testid="ai-eval-extraction">
            <div className="ai-eval-card-head">
              <h3>字段提取准确率</h3>
              <span className="ai-eval-score">{pct(report.extraction.accuracy)}</span>
            </div>
            <p className="ai-eval-sub">
              关键字段与标准答案一致：{num(report.extraction.matched)} / {num(report.extraction.total)}
            </p>
            <div className="table-wrap">
              <table className="ship-table ai-eval-table">
                <thead>
                  <tr>
                    <th>单证</th>
                    <th>字段</th>
                    <th>标准答案</th>
                    <th>实际提取</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody>
                  {report.extraction.items.map((it, i) => (
                    <tr key={`${it.file}-${it.field}-${i}`}>
                      <td>{it.file}</td>
                      <td className="ai-mono">{it.field}</td>
                      <td className="ai-mono">{it.expected}</td>
                      <td className="ai-mono">{it.actual}</td>
                      <td>
                        <span className={`ai-chip tone-${it.ok ? 'good' : 'danger'}`}>{it.ok ? '一致' : '不一致'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 2. 跨单证冲突识别 */}
          <div className="ai-eval-card glass-panel" data-testid="ai-eval-conflict">
            <div className="ai-eval-card-head">
              <h3>跨单证冲突识别</h3>
              <span className="ai-eval-score">
                {num(report.conflict.passed)} / {num(report.conflict.total)}
              </span>
            </div>
            <p className="ai-eval-sub">正常单证不误报，冲突单证识别出 1000 PCS vs 900 PCS。</p>
            <ul className="ai-case-list">
              {report.conflict.cases.map((c) => (
                <li key={c.name}>
                  <div className="ai-case-head">
                    <span className={`ai-chip tone-${c.ok ? 'good' : 'danger'}`}>{c.ok ? '通过' : '未通过'}</span>
                    <strong>{c.name}</strong>
                    <span className="ai-case-expect">
                      期望 {c.expected === 'consistent' ? '一致' : '冲突'} · 实际 {c.actual}
                    </span>
                  </div>
                  <p className="ai-case-summary">{c.summary}</p>
                </li>
              ))}
            </ul>
          </div>

          {/* 3. 证据引用有效性 */}
          <div className="ai-eval-card glass-panel" data-testid="ai-eval-evidence">
            <div className="ai-eval-card-head">
              <h3>证据引用有效性</h3>
              <span className="ai-eval-score">{pct(report.evidence.rate)}</span>
            </div>
            <p className="ai-eval-sub">
              AI 引用的原文片段真实存在于单证中：{num(report.evidence.valid)} / {num(report.evidence.total)}
            </p>
            <ul className="ai-evidence-list">
              {report.evidence.items.map((it, i) => (
                <li key={`${it.file}-${it.field}-${i}`}>
                  <span className={`ai-chip tone-${it.ok ? 'good' : 'danger'}`}>{it.ok ? '有效' : '无效'}</span>
                  <span className="ai-evidence-file">{it.file}</span>
                  <span className="ai-mono">{it.field}</span>
                  <span className="ai-evidence-quote">
                    {it.quote || '（未提供引用）'}
                    {it.page ? ` · 第 ${it.page} 页` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  )
}
