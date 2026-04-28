function ProgressBar({ percent, color }: { percent: number; color: string }) {
  return (
    <div className="h-[3px] overflow-hidden rounded-full bg-[#27272a]">
      <div
        className="h-full rounded-full"
        style={{ width: `${percent}%`, backgroundColor: color }}
      />
    </div>
  );
}

const missions = [
  { name: 'bump fast-glob', done: 138, total: 140, color: '#22c55e' },
  { name: 'add OTel spans', done: 24, total: 67, color: '#3b82f6' },
  { name: 'fix CVE-2024-4067', done: 8, total: 22, color: '#f59e0b' },
] as const;

export function ConsoleMock() {
  return (
    <div className="w-[260px] shrink-0 rounded-[10px] border border-[#27272a] bg-[#18181b] p-5">
      <div className="mb-4 text-[10px] uppercase tracking-widest text-[#52525b]">
        Mission Control
      </div>
      {missions.map((m) => (
        <div key={m.name} className="mb-3.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs text-[#a1a1aa]">{m.name}</span>
            <span className="text-[11px]" style={{ color: m.color }}>
              ● {m.done}/{m.total}
            </span>
          </div>
          <ProgressBar
            percent={Math.round((m.done / m.total) * 100)}
            color={m.color}
          />
        </div>
      ))}
      <div className="my-3.5 h-px bg-[#27272a]" />
      <div className="flex justify-between text-[11px]">
        <span className="text-[#52525b]">Budget</span>
        <span className="text-[#a1a1aa]">$12.40 / $50.00</span>
      </div>
    </div>
  );
}
