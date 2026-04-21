-- Demo data for Phase 1 exploration. Uses fixed UUIDs so the rows are easy to
-- identify. On Supabase, create matching auth users first (or run this after
-- signing up with these IDs); on a local Postgres without auth schema, the
-- accounts rows stand alone.

insert into accounts (
  user_id, first_name, last_name, address, date_of_birth,
  chequing_balance, savings_balance, credit_balance, credit_limit, credit_score
) values
  ('11111111-1111-1111-1111-111111111111', 'Nirav',  'Polara',  '123 King St W, Toronto, ON', '1998-05-12',
   1200.00, 8500.00, 1800.00, 5000.00, 672),
  ('22222222-2222-2222-2222-222222222222', 'Amelia', 'Chen',    '45 Yonge St, Toronto, ON',   '1995-09-02',
   3200.50, 15200.00, 450.00, 8000.00, 741),
  ('33333333-3333-3333-3333-333333333333', 'Marcus', 'Johnson', '900 Bay St, Toronto, ON',    '1990-01-21',
   640.10,   2100.00, 3900.00, 4500.00, 612)
on conflict (user_id) do nothing;

insert into expenses (user_id, category, amount, occurred_at) values
  ('11111111-1111-1111-1111-111111111111', 'rent',          1500.00, current_date - 5),
  ('11111111-1111-1111-1111-111111111111', 'food',            82.30, current_date - 3),
  ('11111111-1111-1111-1111-111111111111', 'transport',       14.75, current_date - 2),
  ('11111111-1111-1111-1111-111111111111', 'subscriptions',   19.99, current_date - 10),
  ('22222222-2222-2222-2222-222222222222', 'rent',          2100.00, current_date - 6),
  ('22222222-2222-2222-2222-222222222222', 'food',           145.20, current_date - 1),
  ('33333333-3333-3333-3333-333333333333', 'rent',           950.00, current_date - 7),
  ('33333333-3333-3333-3333-333333333333', 'food',            63.40, current_date - 4);
