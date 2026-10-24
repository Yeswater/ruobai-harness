export function DiffView({ diff }: { diff: string }) {
  return (
    <div className="approval-diff">
      {diff.split('\n').map((line, index) => {
        const kind = line.startsWith('+++') || line.startsWith('---')
          ? 'meta'
          : line.startsWith('+')
            ? 'add'
            : line.startsWith('-') ? 'del' : 'context'
        return <div key={index} className={`diff-line ${kind}`}>{line || ' '}</div>
      })}
    </div>
  )
}
