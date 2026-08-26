/**
 * Compact, accessible pagination control.
 * Shows up to 7 page buttons; collapses to ellipsis when pages > 7.
 * Mobile-safe: uses icon-only prev/next buttons with aria-labels.
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface PaginationProps {
  page: number;        // 1-based current page
  totalPages: number;
  onChange: (page: number) => void;
  className?: string;
}

/** Compute the page numbers to render, inserting `null` for ellipsis. */
function getPageNumbers(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages: (number | null)[] = [];
  const WINDOW = 1; // siblings around current

  const leftEdge  = [1, 2];
  const rightEdge = [total - 1, total];
  const mid = Array.from(
    { length: WINDOW * 2 + 1 },
    (_, i) => current - WINDOW + i,
  ).filter(p => p > 2 && p < total - 1);

  const all = [...new Set([...leftEdge, ...mid, ...rightEdge])].sort((a, b) => a - b);

  for (let i = 0; i < all.length; i++) {
    if (i > 0 && all[i] - all[i - 1] > 1) pages.push(null); // ellipsis
    pages.push(all[i]);
  }
  return pages;
}

export function Pagination({ page, totalPages, onChange, className }: PaginationProps) {
  if (totalPages <= 1) return null;

  const pages = getPageNumbers(page, totalPages);

  return (
    <div className={cn('flex items-center justify-center gap-1 flex-wrap', className)}>
      {/* Previous */}
      <Button
        variant="outline"
        size="sm"
        className="h-7 w-7 p-0"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        aria-label="Previous page"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
      </Button>

      {/* Page numbers */}
      {pages.map((p, i) =>
        p === null ? (
          <span key={`ellipsis-${i}`} className="text-xs text-muted-foreground px-1 select-none">
            …
          </span>
        ) : (
          <Button
            key={p}
            variant={p === page ? 'default' : 'outline'}
            size="sm"
            className={cn(
              'h-7 min-w-7 px-2 text-xs',
              p === page && 'bg-primary text-primary-foreground pointer-events-none',
            )}
            onClick={() => onChange(p)}
            aria-label={`Page ${p}`}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </Button>
        ),
      )}

      {/* Next */}
      <Button
        variant="outline"
        size="sm"
        className="h-7 w-7 p-0"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
        aria-label="Next page"
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}
