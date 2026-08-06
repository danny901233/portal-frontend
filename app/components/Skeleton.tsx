import { cn } from '../lib/utils';

/**
 * Shimmering placeholder building block. Compose into rows, tables, cards.
 * Uses the `rm-shimmer` animation defined in globals.css.
 */
export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn('rm-shimmer block rounded-md', className)}
      style={style}
    />
  );
}

export function SkeletonText({
  lines = 1,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <span className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-3 w-full"
          style={{ width: i === lines - 1 && lines > 1 ? '70%' : '100%' }}
        />
      ))}
    </span>
  );
}

export function SkeletonRow({ columns }: { columns: number[] }) {
  return (
    <div className="grid items-center gap-4 border-b border-slate-800/50 px-4 py-3" style={{ gridTemplateColumns: columns.map((c) => `${c}fr`).join(' ') }}>
      {columns.map((_, i) => (
        <Skeleton key={i} className="h-3" />
      ))}
    </div>
  );
}

export function SkeletonTable({
  rows = 6,
  columns = [3, 4, 2, 2, 1],
}: {
  rows?: number;
  columns?: number[];
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800/60 bg-slate-900/40">
      <div className="grid items-center gap-4 border-b border-slate-800 bg-slate-900/60 px-4 py-3" style={{ gridTemplateColumns: columns.map((c) => `${c}fr`).join(' ') }}>
        {columns.map((_, i) => (
          <Skeleton key={i} className="h-2.5 w-16 opacity-70" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} columns={columns} />
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn('rm-card flex flex-col gap-3 p-5', className)}>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-7 w-32" />
      <Skeleton className="h-2.5 w-full" />
      <Skeleton className="h-2.5 w-3/4" />
    </div>
  );
}