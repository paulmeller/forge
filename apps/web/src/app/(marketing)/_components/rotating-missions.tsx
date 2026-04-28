'use client';

import { useEffect, useState } from 'react';

const missions = [
  'Migrate 200 services from Express to Fastify.',
  'Convert your entire test suite from Jest to Vitest.',
  'Patch every CVE across your org by morning.',
  'Add OpenTelemetry to every HTTP handler in payments.',
  'Move 50 repos into a monorepo, in dependency order.',
  'Upgrade every service from Node 18 to Node 22.',
  'Triage every P3 bug older than 90 days. Fix the easy ones.',
  'Migrate from REST to gRPC across 80 microservices.',
  'Apply your new auth middleware to every service that touches PII.',
  'Rewrite your COBOL billing system in Go.',
];

export function RotatingMissions() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex((i) => (i + 1) % missions.length);
        setVisible(true);
      }, 400);
    }, 3500);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="mx-auto max-w-[960px] px-6 py-[72px] md:px-12">
      <h2 className="mb-10 text-center text-2xl font-semibold tracking-tight">
        One mission. Hundreds of repos.
      </h2>
      <div className="flex items-center justify-center" style={{ minHeight: '3rem' }}>
        <p
          className="text-center text-[28px] font-medium leading-snug tracking-tight text-[#a1a1aa] transition-opacity duration-300 md:text-[36px]"
          style={{ opacity: visible ? 1 : 0 }}
        >
          &ldquo;{missions[index]}&rdquo;
        </p>
      </div>
    </section>
  );
}
