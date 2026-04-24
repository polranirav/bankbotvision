"use client";

import { useState } from "react";
import type { AccountCreate } from "@/types/account";

type FormValues = Omit<AccountCreate, "pin">;

type Props = {
  initial?: Partial<FormValues>;
  submitLabel?: string;
  onSubmit: (values: FormValues) => Promise<void>;
};

export function AccountForm({ initial = {}, submitLabel = "Save", onSubmit }: Props) {
  const [values, setValues] = useState<FormValues>({
    first_name: initial.first_name ?? "",
    last_name: initial.last_name ?? "",
    address: initial.address ?? "",
    date_of_birth: initial.date_of_birth ?? "",
    chequing_balance: initial.chequing_balance ?? 0,
    savings_balance: initial.savings_balance ?? 0,
    credit_balance: initial.credit_balance ?? 0,
    credit_limit: initial.credit_limit ?? 0,
    credit_score: initial.credit_score ?? null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof FormValues>(key: K, v: FormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ ...values });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded border border-neutral-300 px-3 py-2";
  const label = "block text-sm font-medium text-neutral-700";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={label}>First name</label>
          <input
            className={input}
            required
            value={values.first_name}
            onChange={(e) => set("first_name", e.target.value)}
          />
        </div>
        <div>
          <label className={label}>Last name</label>
          <input
            className={input}
            required
            value={values.last_name}
            onChange={(e) => set("last_name", e.target.value)}
          />
        </div>
      </div>

      <div>
        <label className={label}>Address</label>
        <input
          className={input}
          value={values.address ?? ""}
          onChange={(e) => set("address", e.target.value)}
        />
      </div>

      <div>
        <label className={label}>Date of birth</label>
        <input
          type="date"
          className={input}
          value={values.date_of_birth ?? ""}
          onChange={(e) => set("date_of_birth", e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <NumberField label="Chequing balance" value={values.chequing_balance ?? 0} onChange={(v) => set("chequing_balance", v)} />
        <NumberField label="Savings balance" value={values.savings_balance ?? 0} onChange={(v) => set("savings_balance", v)} />
        <NumberField label="Credit balance" value={values.credit_balance ?? 0} onChange={(v) => set("credit_balance", v)} />
        <NumberField label="Credit limit" value={values.credit_limit ?? 0} onChange={(v) => set("credit_limit", v)} />
      </div>

      <div>
        <label className={label}>Credit score</label>
        <input
          type="number"
          min={300}
          max={900}
          className={input}
          value={values.credit_score ?? ""}
          onChange={(e) => set("credit_score", e.target.value === "" ? null : Number(e.target.value))}
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="rounded bg-neutral-900 px-4 py-2 text-white hover:bg-neutral-700 disabled:opacity-50"
      >
        {busy ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-neutral-700">{label}</label>
      <input
        type="number"
        step="0.01"
        className="w-full rounded border border-neutral-300 px-3 py-2"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
