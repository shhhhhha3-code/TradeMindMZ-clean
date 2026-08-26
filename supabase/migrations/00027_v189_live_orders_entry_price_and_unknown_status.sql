
-- V189: Add entry_price column to live_orders for trade reference tracking.
-- Also ensures ORDER_STATUS_UNKNOWN status is allowed in the constraint
-- (already present from 00024 as 'UNKNOWN' — this is additive-safe).

ALTER TABLE live_orders
  ADD COLUMN IF NOT EXISTS entry_price numeric(20, 8);

-- Also add quantity column (was missing — only filled_qty existed)
ALTER TABLE live_orders
  ADD COLUMN IF NOT EXISTS quantity numeric(20, 8);

COMMENT ON COLUMN live_orders.entry_price IS
  'Reference/signal entry price at order creation time. Used for P&L baseline.';

COMMENT ON COLUMN live_orders.quantity IS
  'Rounded quantity sent to Pionex (basePrecision-floored). Immutable after order creation.';
