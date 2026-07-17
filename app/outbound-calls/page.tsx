"use client";

// Outbound calls — verify the garage's OWN number as the caller ID, place
// click-to-call bridge calls (your phone rings, then connects to the number,
// showing the garage's number), and see the outbound call log.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { getGarageId } from "../lib/auth";
import {
  getOutboundCallerId,
  startCallerIdVerification,
  checkCallerIdStatus,
  placeOutboundCall,
  fetchOutboundCallLogs,
} from "../lib/api";

type LogRow = { id: string; toNumber: string; callerId: string; agentPhone: string; status: string; durationSeconds: number | null; createdAt: string };

function statusStyle(s: string) {
  const v = s.toLowerCase();
  if (v === "completed") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (["failed", "busy", "no-answer", "canceled"].includes(v)) return "bg-rose-50 text-rose-700 border-rose-200";
  return "bg-slate-100 text-slate-600 border-slate-200";
}

export default function OutboundCallsPage() {
  const [garageId, setGarageId] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [callerId, setCallerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [numberInput, setNumberInput] = useState("");
  const [validationCode, setValidationCode] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [toNumber, setToNumber] = useState("");
  const [agentPhone, setAgentPhone] = useState("");
  const [dialing, setDialing] = useState(false);
  const [dialMsg, setDialMsg] = useState<string | null>(null);
  const [dialErr, setDialErr] = useState<string | null>(null);

  const [logs, setLogs] = useState<LogRow[]>([]);

  const loadLogs = useCallback((gid: string) => {
    fetchOutboundCallLogs(gid).then((r) => setLogs(r.logs)).catch(() => {});
  }, []);

  useEffect(() => {
    const gid = getGarageId();
    setGarageId(gid);
    if (typeof window !== "undefined") setAgentPhone(localStorage.getItem("rm_agent_phone") || "");
    if (!gid) { setLoading(false); return; }
    getOutboundCallerId(gid).then((r) => { setVerified(r.verified); setCallerId(r.number); }).catch(() => {}).finally(() => setLoading(false));
    loadLogs(gid);
  }, [loadLogs]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const startVerify = useCallback(async () => {
    if (!garageId) return;
    setVerifyErr(null); setValidationCode(null); setVerifying(true);
    try {
      const r = await startCallerIdVerification(garageId, numberInput.trim());
      if (r.alreadyVerified) { setVerified(true); setCallerId(r.number); setVerifying(false); return; }
      setValidationCode(r.validationCode || null); setCallerId(r.number);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const s = await checkCallerIdStatus(garageId);
          if (s.verified) { setVerified(true); setCallerId(s.number); setVerifying(false); setValidationCode(null); if (pollRef.current) clearInterval(pollRef.current); }
        } catch { /* keep polling */ }
      }, 3000);
    } catch (e: unknown) {
      setVerifyErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error || "Couldn't start verification.");
      setVerifying(false);
    }
  }, [garageId, numberInput]);

  const call = useCallback(async () => {
    if (!garageId) return;
    setDialErr(null); setDialMsg(null); setDialing(true);
    try {
      if (typeof window !== "undefined") localStorage.setItem("rm_agent_phone", agentPhone.trim());
      await placeOutboundCall(garageId, toNumber.trim(), agentPhone.trim());
      setDialMsg(`Calling… your phone (${agentPhone.trim()}) will ring — answer it and you'll be connected to ${toNumber.trim()}.`);
      setToNumber("");
      setTimeout(() => loadLogs(garageId), 1500);
    } catch (e: unknown) {
      setDialErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error || "Couldn't place the call.");
    } finally { setDialing(false); }
  }, [garageId, toNumber, agentPhone, loadLogs]);

  const inputCls = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50 disabled:opacity-60";

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">Call Activity</h1>
        <p className="text-sm text-slate-500">Inbound calls answered by your AI receptionist, and outbound calls you place.</p>
      </div>

      {/* Tabs */}
      <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 text-sm shadow-sm">
        <Link href="/calls" className="rounded-md px-4 py-1.5 font-medium text-slate-500 hover:text-slate-800">Inbound</Link>
        <span className="rounded-md bg-brand-600 px-4 py-1.5 font-semibold text-white">Outbound</span>
      </div>

      {loading ? (
        <div className="text-slate-500">Loading…</div>
      ) : !garageId ? (
        <div className="text-slate-500">Select a branch to set up outbound calling.</div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            {/* Caller ID */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-brand-600">Your caller ID</h2>
              {verified ? (
                <div className="mt-3 flex items-center gap-2 text-sm text-slate-700">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100">
                    <svg className="h-3.5 w-3.5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                  </span>
                  Verified — calls show <strong className="text-slate-900">{callerId}</strong>
                  <button onClick={() => { setVerified(false); setValidationCode(null); setNumberInput(callerId || ""); }} className="ml-auto text-xs font-medium text-brand-600 hover:underline">Change</button>
                </div>
              ) : validationCode ? (
                <div className="mt-3 rounded-lg border border-brand-100 bg-brand-50 p-4">
                  <p className="text-sm text-slate-700">We&apos;re calling <strong className="text-slate-900">{callerId}</strong> now. Answer and key in this code:</p>
                  <p className="mt-2 text-center font-mono text-3xl font-bold tracking-widest text-brand-700">{validationCode}</p>
                  <p className="mt-2 text-center text-xs text-slate-500">Waiting for confirmation… updates automatically.</p>
                </div>
              ) : (
                <div className="mt-3">
                  <p className="text-sm text-slate-600">Enter the garage&apos;s existing number. We&apos;ll call it once to confirm you own it — then it&apos;s used as your caller ID (nothing is moved or ported).</p>
                  <div className="mt-3 flex gap-2">
                    <input value={numberInput} onChange={(e) => setNumberInput(e.target.value)} placeholder="e.g. 01926 895340" className={inputCls} />
                    <button onClick={startVerify} disabled={verifying || !numberInput.trim()} className="shrink-0 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{verifying ? "Calling…" : "Verify"}</button>
                  </div>
                  {verifyErr && <p className="mt-2 text-sm text-rose-600">{verifyErr}</p>}
                </div>
              )}
            </section>

            {/* Make a call */}
            <section className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${verified ? "" : "opacity-60"}`}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-brand-600">Make a call</h2>
              {!verified && <p className="mt-2 text-sm text-slate-500">Verify your caller ID first.</p>}
              <div className="mt-3 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600">Number to call</label>
                  <input value={toNumber} onChange={(e) => setToNumber(e.target.value)} disabled={!verified} placeholder="supplier / customer number" className={`mt-1 ${inputCls}`} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600">Your phone (rings first)</label>
                  <input value={agentPhone} onChange={(e) => setAgentPhone(e.target.value)} disabled={!verified} placeholder="your mobile" className={`mt-1 ${inputCls}`} />
                </div>
                <button onClick={call} disabled={!verified || dialing || !toNumber.trim() || !agentPhone.trim()} className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
                  <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 013 4c0-.6.5-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.4 0 .8-.3 1l-2.2 2.2z" /></svg>
                  {dialing ? "Connecting…" : "Call"}
                </button>
                {dialMsg && <p className="text-sm text-emerald-700">{dialMsg}</p>}
                {dialErr && <p className="text-sm text-rose-600">{dialErr}</p>}
              </div>
            </section>
          </div>

          {/* Outbound call log */}
          <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Outbound call log</h2>
              <button onClick={() => garageId && loadLogs(garageId)} className="text-xs font-medium text-brand-600 hover:underline">Refresh</button>
            </div>
            {logs.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-slate-400">No outbound calls yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="px-5 py-2 font-medium">When</th>
                      <th className="px-5 py-2 font-medium">To</th>
                      <th className="px-5 py-2 font-medium">Status</th>
                      <th className="px-5 py-2 font-medium">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((l) => (
                      <tr key={l.id} className="border-b border-slate-100 text-slate-700">
                        <td className="whitespace-nowrap px-5 py-2.5 text-slate-500">{new Date(l.createdAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                        <td className="whitespace-nowrap px-5 py-2.5">{l.toNumber}</td>
                        <td className="px-5 py-2.5"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${statusStyle(l.status)}`}>{l.status.replace(/-/g, " ")}</span></td>
                        <td className="whitespace-nowrap px-5 py-2.5 text-slate-500">{l.durationSeconds != null ? `${l.durationSeconds}s` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
