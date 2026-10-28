import { useMemo } from 'react'
import type { ActivitySummary } from '../api.ts'
import { buildContributionWeeks, parseDayKey } from '../contribution-model.ts'

interface ContributionGraphProps {
  activity: ActivitySummary | null
}

const WEEKDAY_LABELS = ['', '', '一', '', '三', '', '五', '']

function dayTitle(date: string, count: number) {
  const parsed = parseDayKey(date)
  return `${parsed.getMonth() + 1}月${parsed.getDate()}日 · ${count} 次贡献`
}

/**
 * Yearly contribution graph for a session that has no messages yet.
 *
 * It replaces the old "从这里开始" card: instead of three canned prompts, the
 * empty screen shows what this harness has actually done, which is both a
 * quieter first screen and a reason to send the first message.
 */
export function ContributionGraph({ activity }: ContributionGraphProps) {
  const weeks = useMemo(
    () => activity ? buildContributionWeeks(activity.days, activity.max) : [],
    [activity],
  )
  const total = activity?.total ?? 0
  const empty = !activity || total === 0

  return (
    <section className="contrib" aria-labelledby="contrib-title">
      <header className="contrib-head">
        <h2 id="contrib-title">
          {empty ? '过去一年还没有贡献' : `过去一年共 ${total} 次贡献`}
        </h2>
        <p>
          {empty
            ? '发出第一条消息，今天就会点亮第一格。'
            : '每一格是一天，按当天发出的消息计数。'}
        </p>
      </header>

      <div className="contrib-card">
        <div className="contrib-scroll">
          <div className="contrib-weekdays" aria-hidden="true">
            {WEEKDAY_LABELS.map((label, index) => <span key={index}>{label}</span>)}
          </div>
          <div
            className="contrib-grid"
            role="img"
            aria-label={`过去一年共 ${total} 次贡献`}
          >
            {weeks.map(week => (
              <div className="contrib-week" key={week.key}>
                <span className="contrib-month">{week.label ?? ''}</span>
                {week.cells.map((cell, index) => cell
                  ? (
                    <span
                      key={cell.date}
                      className={`contrib-cell level-${cell.level}`}
                      title={dayTitle(cell.date, cell.count)}
                    />
                  )
                  : <span key={`blank-${index}`} className="contrib-cell blank" />)}
              </div>
            ))}
          </div>
        </div>

        <footer className="contrib-foot">
          <span className="contrib-note">统计自本地会话记录</span>
          <span className="contrib-legend">
            <span>少</span>
            {[0, 1, 2, 3, 4].map(level => (
              <span key={level} className={`contrib-cell level-${level}`} />
            ))}
            <span>多</span>
          </span>
        </footer>
      </div>
    </section>
  )
}
