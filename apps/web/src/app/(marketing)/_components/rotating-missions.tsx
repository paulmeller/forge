'use client';

import { useEffect, useState } from 'react';

const missions = [
  'Migrate 200 services from Express to Fastify.',
  'Bump every CVE across your org in one afternoon.',
  'Localize 50 blog posts into 8 languages.',
  'Review 200 vendor contracts against updated policy.',
  'Add OpenTelemetry spans to 40 microservices.',
  'Generate Q3 analysis for every client dataset.',
  'Replace Jest with Vitest across your monorepo.',
  'Draft personalized proposals for 100 enterprise leads.',
  'Upgrade all repos from Node 18 to Node 22.',
  'Audit 300 product descriptions for compliance.',
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
      }, 300);
    }, 3500);
    return () => clearInterval(interval);
  }, []);

  return (
    <p
      className="text-center text-[28px] font-medium leading-snug tracking-tight text-muted-foreground transition-opacity duration-300 md:text-[36px]"
      style={{ opacity: visible ? 1 : 0 }}
    >
      &ldquo;{missions[index]}&rdquo;
    </p>
  );
}
