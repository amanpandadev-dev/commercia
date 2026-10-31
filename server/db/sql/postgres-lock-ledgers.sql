-- Run ONCE after go-live, when the test data has been wiped (Settings → Before go-live) and real work has begun.
-- The append-only tables can then no longer be changed or deleted by the app's login at all, whatever the app does:
-- the database refuses, on top of the triggers that already refuse. ("Reset test data" stops working, which is the point.)
REVOKE UPDATE, DELETE ON ledger, activity, versions, payment_parts, supplier_ledger FROM commercia_app;
