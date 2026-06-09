export default function DashboardPage() {
  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="mx-auto max-w-5xl px-6 py-16">
        <header className="border-b border-neutral-200 pb-8">
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
            Platinumlist · Performance Marketing
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Campaign Optimisation Dashboard
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-neutral-600">
            Internal decision tool. Surfaces active paid campaigns as cards,
            walks the 6-lens investigation on every Red Flag, and proposes one
            of six actions. Nothing executes without a human click.
          </p>
        </header>

        <section className="mt-10 rounded-lg border border-dashed border-neutral-300 bg-white p-8">
          <h2 className="text-sm font-semibold text-neutral-800">
            Phase 1b · Scaffold
          </h2>
          <p className="mt-2 text-sm text-neutral-600">
            Project skeleton is live. Decision cards, the Red Flag detector, and
            the 6-lens AI brain arrive in Phase 2. No live data is wired yet.
          </p>
        </section>
      </div>
    </main>
  );
}
