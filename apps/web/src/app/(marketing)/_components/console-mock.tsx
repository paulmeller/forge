'use client';

import { useEffect, useState } from 'react';

function ProgressBar({ percent, color }: { percent: number; color: string }) {
  return (
    <div className="h-[3px] overflow-hidden rounded-full bg-[#27272a]">
      <div
        className="h-full rounded-full transition-all duration-700"
        style={{ width: `${percent}%`, backgroundColor: color }}
      />
    </div>
  );
}

const missionSets = [
  {
    missions: [
      { name: 'express-to-fastify', done: 142, total: 200, color: '#3b82f6' },
      { name: 'update test configs', done: 189, total: 200, color: '#22c55e' },
      { name: 'remove old middleware', done: 67, total: 200, color: '#f59e0b' },
    ],
    budget: '$34.80 / $100',
  },
  {
    missions: [
      { name: 'jest-to-vitest', done: 312, total: 340, color: '#22c55e' },
      { name: 'update CI configs', done: 340, total: 340, color: '#22c55e' },
      { name: 'remove jest deps', done: 280, total: 340, color: '#3b82f6' },
    ],
    budget: '$18.20 / $50',
  },
  {
    missions: [
      { name: 'CVE-2024-4067', done: 22, total: 22, color: '#22c55e' },
      { name: 'CVE-2024-8901', done: 15, total: 18, color: '#3b82f6' },
      { name: 'CVE-2025-0114', done: 3, total: 9, color: '#f59e0b' },
    ],
    budget: '$8.40 / $30',
  },
  {
    missions: [
      { name: 'add OTel spans', done: 54, total: 67, color: '#3b82f6' },
      { name: 'add trace headers', done: 67, total: 67, color: '#22c55e' },
      { name: 'update dashboards', done: 12, total: 67, color: '#f59e0b' },
    ],
    budget: '$22.10 / $75',
  },
  {
    missions: [
      { name: 'bump to node 22', done: 156, total: 180, color: '#22c55e' },
      { name: 'fix breaking changes', done: 98, total: 180, color: '#3b82f6' },
      { name: 'update CI images', done: 180, total: 180, color: '#22c55e' },
    ],
    budget: '$41.30 / $80',
  },
  {
    missions: [
      { name: 'triage P3 backlog', done: 84, total: 127, color: '#3b82f6' },
      { name: 'auto-fix simple bugs', done: 31, total: 127, color: '#f59e0b' },
      { name: 'close stale issues', done: 120, total: 127, color: '#22c55e' },
    ],
    budget: '$15.60 / $40',
  },
  {
    missions: [
      { name: 'rest-to-grpc protos', done: 80, total: 80, color: '#22c55e' },
      { name: 'migrate clients', done: 44, total: 80, color: '#3b82f6' },
      { name: 'deprecate REST', done: 12, total: 80, color: '#f59e0b' },
    ],
    budget: '$52.00 / $120',
  },
  {
    missions: [
      { name: 'add auth middleware', done: 38, total: 45, color: '#22c55e' },
      { name: 'update PII handlers', done: 29, total: 45, color: '#3b82f6' },
      { name: 'audit logging', done: 11, total: 45, color: '#f59e0b' },
    ],
    budget: '$19.70 / $60',
  },
  {
    missions: [
      { name: 'monorepo: move svc-a', done: 1, total: 1, color: '#22c55e' },
      { name: 'monorepo: move svc-b', done: 1, total: 1, color: '#22c55e' },
      { name: 'monorepo: move svc-c', done: 0, total: 1, color: '#3b82f6' },
    ],
    budget: '$28.90 / $50',
  },
  {
    missions: [
      { name: 'cobol-to-go: billing', done: 4, total: 12, color: '#f59e0b' },
      { name: 'cobol-to-go: ledger', done: 1, total: 8, color: '#f59e0b' },
      { name: 'cobol-to-go: reports', done: 0, total: 6, color: '#52525b' },
    ],
    budget: '$89.40 / $200',
  },
];

export function ConsoleMock() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex((i) => (i + 1) % missionSets.length);
        setVisible(true);
      }, 400);
    }, 3500);
    return () => clearInterval(interval);
  }, []);

  const current = missionSets[index]!;

  return (
    <div className="w-[260px] shrink-0 rounded-[10px] border border-[#27272a] bg-[#18181b] p-5">
      <div className="mb-4 text-[10px] uppercase tracking-widest text-[#52525b]">
        Mission Control
      </div>
      <div
        className="transition-opacity duration-300"
        style={{ opacity: visible ? 1 : 0 }}
      >
        {current.missions.map((m) => (
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
          <span className="text-[#a1a1aa]">{current.budget}</span>
        </div>
      </div>
    </div>
  );
}
