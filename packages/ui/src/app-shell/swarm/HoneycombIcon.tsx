import { cn } from "@/components/lib/utils.js";

/** Three hexagon cells: the swarm. */
export function HoneycombIcon({ className }: { className?: string }) {
  const cell = (x: number, y: number) =>
    `M${x} ${y - 4.2}l3.6 2.1v4.2l-3.6 2.1l-3.6-2.1v-4.2z`;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" aria-hidden="true" className={cn("shrink-0", className)}>
      <path d={cell(8.3, 8.4)} />
      <path d={cell(15.7, 8.4)} />
      <path d={cell(12, 14.9)} />
    </svg>
  );
}
