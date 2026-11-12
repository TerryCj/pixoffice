import type { FinancePanelData } from '@pixoffice/protocol/dashboard'

function usd(value: number | undefined) {
  return value === undefined ? '暂无' : `$${value.toFixed(2)}`
}

function formatTime(value: string | undefined) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function quotaTone(percent: number) {
  return percent < 70 ? 'quota-ok' : percent < 90 ? 'quota-warn' : 'quota-high'
}

/** 成本面板：财务总监推送的用量与额度数据。缺失字段一律显示“暂无”，不编数字。 */
export function FinancePanel({ finance }: { finance?: FinancePanelData }) {
  const quota = finance?.quotaUsedPercent
  const quotaKnown = quota !== undefined && quota >= 0
  return <section aria-label="成本面板">
    <div className="runtime-panel-heading runtime-finance-heading"><h2>成本面板</h2><span>财务总监</span></div>
    {!finance ? <p className="runtime-empty">暂无成本数据</p> : <div className="runtime-finance">
      <div className="runtime-finance-row"><span>中转站余额（估算）</span><strong>{usd(finance.relayBalanceUsd)}</strong></div>
      <div className="runtime-finance-row"><span>累计消费（估算）</span><strong>{usd(finance.relaySpentUsd)}</strong></div>
      <div className="runtime-finance-row"><span>预算</span><strong>{usd(finance.relayBudgetUsd)}</strong></div>
      <div className="runtime-finance-sub">按模型</div>
      {finance.byModel?.length ? finance.byModel.map(item => <div className="runtime-finance-row" key={item.model}><span>{item.model}</span><strong>{item.calls} 次 · {usd(item.costUsd)}</strong></div>) : <p className="runtime-empty">暂无</p>}
      <div className="runtime-finance-sub">按天</div>
      {finance.byDay?.length ? finance.byDay.map(item => <div className="runtime-finance-row" key={item.date}><span>{item.date}</span><strong>{usd(item.costUsd)}</strong></div>) : <p className="runtime-empty">暂无</p>}
      <div className="runtime-finance-sub">Muse 额度</div>
      {quotaKnown ? <div className="runtime-resource-row"><span>已用</span><div className="runtime-meter"><i className={quotaTone(quota)} style={{ width: `${quota}%` }} /></div><strong>{Math.round(quota)}%</strong></div> : <p className="runtime-empty">暂无</p>}
      {finance.quotaResetsAt && <div className="runtime-finance-row"><span>额度重置</span><strong>{finance.quotaResetsAt}</strong></div>}
      {finance.alert && <p className="runtime-finance-alert">{finance.alert}</p>}
      {formatTime(finance.updatedAt) && <p className="runtime-finance-updated">更新于 {formatTime(finance.updatedAt)}</p>}
    </div>}
  </section>
}
