export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4 animate-in fade-in">
      <div className="text-muted-foreground bg-accent p-6 rounded-full">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="48"
          height="48"
          viewBox="0 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="lucide lucide-search-x"
        >
          <path d="m13.5 8.5-5 5" />
          <path d="m8.5 8.5 5 5" />
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </div>
      <h1 className="text-2xl font-bold tracking-tight mt-4">Pagina niet gevonden</h1>
      <p className="text-muted-foreground max-w-md">
        De opgevraagde pagina of repository bestaat niet of u heeft hier geen toegang toe.
      </p>
      <a
        href="/"
        className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium transition-colors hover:bg-primary/90"
      >
        Terug naar overzicht
      </a>
    </div>
  );
}
