"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { api } from "@/lib/api";
import { AccountForm } from "@/components/AccountForm";
import type { Account, AccountCreate } from "@/types/account";

export default function AccountPage() {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        router.push("/login");
        return;
      }
      try {
        const acc = await api<Account>("/accounts/me");
        setAccount(acc);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  async function handleUpdate(values: AccountCreate) {
    const updated = await api<Account>("/accounts/me", {
      method: "PUT",
      body: JSON.stringify(values),
    });
    setAccount(updated);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/");
  }

  if (loading) return <p className="py-10">Loading…</p>;
  if (error) return <p className="py-10 text-red-600">{error}</p>;
  if (!account) return <p className="py-10">No account found.</p>;

  return (
    <div className="space-y-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          {account.first_name} {account.last_name}
        </h1>
        <button
          onClick={handleSignOut}
          className="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100"
        >
          Sign out
        </button>
      </div>
      <AccountForm
        submitLabel="Save changes"
        initial={{
          first_name: account.first_name,
          last_name: account.last_name,
          address: account.address,
          date_of_birth: account.date_of_birth,
          chequing_balance: Number(account.chequing_balance),
          savings_balance: Number(account.savings_balance),
          credit_balance: Number(account.credit_balance),
          credit_limit: Number(account.credit_limit),
          credit_score: account.credit_score,
        }}
        onSubmit={handleUpdate}
      />
    </div>
  );
}
