"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { api } from "@/lib/api";
import { AccountForm } from "@/components/AccountForm";
import type { Account } from "@/types/account";

type Expense = { id: number; category: string; amount: string; occurred_at: string };

const CATEGORY_EMOJI: Record<string, string> = {
  food: "🍔", rent: "🏠", transport: "🚌", subscriptions: "📱",
  entertainment: "🎬", shopping: "🛍️", utilities: "💡",
};

function fmt(n: string | number) {
  return Number(n).toLocaleString("en-CA", { style: "currency", currency: "CAD" });
}

function CreditBar({ score }: { score: number }) {
  const pct = ((score - 300) / 600) * 100;
  const color = score >= 740 ? "bg-green-500" : score >= 670 ? "bg-yellow-400" : "bg-red-400";
  const label = score >= 740 ? "Excellent" : score >= 670 ? "Good" : score >= 580 ? "Fair" : "Poor";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-neutral-500">
        <span>300</span><span>900</span>
      </div>
      <div className="h-2 rounded-full bg-neutral-200">
        <div className={`h-2 rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-neutral-500">{label}</p>
    </div>
  );
}

export default function AccountPage() {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) { router.push("/login"); return; }
      try {
        const [acc, exp] = await Promise.all([
          api<Account>("/accounts/me"),
          api<Expense[]>("/expenses/me?months=3").catch(() => []),
        ]);
        setAccount(acc);
        setExpenses(exp);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  async function handleUpdate(values: Parameters<typeof AccountForm>[0]["initial"]) {
    const updated = await api<Account>("/accounts/me", { method: "PUT", body: JSON.stringify(values) });
    setAccount(updated);
    setEditing(false);
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/");
  }

  if (loading) return <div className="py-20 text-center text-neutral-400">Loading…</div>;
  if (error)   return <div className="py-20 text-center text-red-500">{error}</div>;
  if (!account) return null;

  const creditUsedPct = account.credit_limit && Number(account.credit_limit) > 0
    ? Math.min(100, (Number(account.credit_balance) / Number(account.credit_limit)) * 100)
    : 0;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="space-y-6 py-8">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{greeting}, {account.first_name} 👋</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            {account.face_image_path
              ? "🟢 Face ID registered"
              : "⚪ No Face ID — go to signup to register"}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setEditing(!editing)} className="rounded border border-neutral-200 px-3 py-1.5 text-sm hover:bg-neutral-50">
            {editing ? "Cancel" : "✏️ Edit"}
          </button>
          <button onClick={signOut} className="rounded border border-neutral-200 px-3 py-1.5 text-sm hover:bg-neutral-50">
            Sign out
          </button>
        </div>
      </div>

      {/* Edit form */}
      {editing && (
        <div className="rounded-xl border border-neutral-200 p-5 bg-neutral-50">
          <h2 className="text-sm font-semibold mb-4 text-neutral-700">Edit Account</h2>
          <AccountForm
            submitLabel="Save changes"
            initial={{
              first_name: account.first_name, last_name: account.last_name,
              address: account.address, date_of_birth: account.date_of_birth,
              chequing_balance: Number(account.chequing_balance),
              savings_balance: Number(account.savings_balance),
              credit_balance: Number(account.credit_balance),
              credit_limit: Number(account.credit_limit),
              credit_score: account.credit_score,
            }}
            onSubmit={handleUpdate}
          />
        </div>
      )}

      {/* Balance cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-neutral-200 p-4 space-y-1">
          <p className="text-xs text-neutral-500 uppercase tracking-wide">Chequing</p>
          <p className="text-2xl font-bold">{fmt(account.chequing_balance)}</p>
          <p className="text-xs text-neutral-400">Available balance</p>
        </div>
        <div className="rounded-xl border border-neutral-200 p-4 space-y-1">
          <p className="text-xs text-neutral-500 uppercase tracking-wide">Savings</p>
          <p className="text-2xl font-bold text-green-600">{fmt(account.savings_balance)}</p>
          <p className="text-xs text-neutral-400">Available balance</p>
        </div>
        <div className="rounded-xl border border-neutral-200 p-4 space-y-1">
          <p className="text-xs text-neutral-500 uppercase tracking-wide">Credit Card</p>
          <p className="text-2xl font-bold text-red-500">{fmt(account.credit_balance)}</p>
          <p className="text-xs text-neutral-400">of {fmt(account.credit_limit)} limit</p>
          <div className="h-1.5 rounded-full bg-neutral-200 mt-2">
            <div className="h-1.5 rounded-full bg-red-400" style={{ width: `${creditUsedPct}%` }} />
          </div>
        </div>
      </div>

      {/* Credit score */}
      {account.credit_score && (
        <div className="rounded-xl border border-neutral-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold">Credit Score</p>
            <span className="text-2xl font-bold">{account.credit_score}</span>
          </div>
          <CreditBar score={account.credit_score} />
        </div>
      )}

      {/* Recent expenses */}
      <div className="rounded-xl border border-neutral-200 p-4">
        <p className="text-sm font-semibold mb-3">Recent Expenses <span className="text-neutral-400 font-normal text-xs">(last 3 months)</span></p>
        {expenses.length === 0 ? (
          <p className="text-sm text-neutral-400">No expenses recorded yet.</p>
        ) : (
          <div className="divide-y divide-neutral-100">
            {expenses.map((e) => (
              <div key={e.id} className="flex items-center justify-between py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{CATEGORY_EMOJI[e.category] ?? "💳"}</span>
                  <div>
                    <p className="text-sm font-medium capitalize">{e.category}</p>
                    <p className="text-xs text-neutral-400">{new Date(e.occurred_at).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}</p>
                  </div>
                </div>
                <span className="text-sm font-semibold">{fmt(e.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Account info footer */}
      <div className="rounded-xl border border-neutral-200 p-4 text-sm text-neutral-500 space-y-1">
        <p><span className="font-medium text-neutral-700">Name</span>: {account.first_name} {account.last_name}</p>
        {account.address && <p><span className="font-medium text-neutral-700">Address</span>: {account.address}</p>}
        {account.date_of_birth && <p><span className="font-medium text-neutral-700">Date of birth</span>: {account.date_of_birth}</p>}
        <p className="text-xs text-neutral-300 pt-1">Member since {new Date(account.created_at).toLocaleDateString("en-CA", { month: "long", year: "numeric" })}</p>
      </div>

    </div>
  );
}
