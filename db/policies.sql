-- Row-Level Security: each user can only read/modify their own data.
-- Service-role key (used by FastAPI) bypasses RLS for admin ops.
-- Apply this against a Supabase project (relies on auth.uid()).

alter table accounts enable row level security;
alter table expenses enable row level security;

-- accounts --------------------------------------------------------------------
drop policy if exists accounts_self_select on accounts;
create policy accounts_self_select on accounts
  for select using (auth.uid() = user_id);

drop policy if exists accounts_self_insert on accounts;
create policy accounts_self_insert on accounts
  for insert with check (auth.uid() = user_id);

drop policy if exists accounts_self_update on accounts;
create policy accounts_self_update on accounts
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists accounts_self_delete on accounts;
create policy accounts_self_delete on accounts
  for delete using (auth.uid() = user_id);

-- expenses --------------------------------------------------------------------
drop policy if exists expenses_self_select on expenses;
create policy expenses_self_select on expenses
  for select using (auth.uid() = user_id);

drop policy if exists expenses_self_insert on expenses;
create policy expenses_self_insert on expenses
  for insert with check (auth.uid() = user_id);

drop policy if exists expenses_self_update on expenses;
create policy expenses_self_update on expenses
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists expenses_self_delete on expenses;
create policy expenses_self_delete on expenses
  for delete using (auth.uid() = user_id);
