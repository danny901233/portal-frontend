export default function NotFound() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center space-y-3 text-center text-slate-300">
      <h1 className="text-3xl font-semibold text-slate-100">Not Found</h1>
      <p className="max-w-md text-sm">
        The page you are looking for could not be located. Double-check the URL or return to the calls
        dashboard.
      </p>
      <a
        href="/calls"
        className="rounded-md border border-slate-700 px-3 py-1 text-xs font-medium text-slate-100 transition-colors hover:border-slate-500 hover:text-slate-50"
      >
        Back to Calls
      </a>
    </div>
  );
}
