export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8 bg-background text-foreground">
      <div className="max-w-2xl space-y-8">
        <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
          Welcome to Docula
        </h1>
        <p className="text-lg leading-8 text-muted-foreground">
          Select a document from the sidebar to get started, or create a new one.
          <br />
          Your internal team documentation, simplified.
        </p>
        <div className="flex items-center justify-center gap-x-6">
           <div className="rounded-md bg-secondary px-3.5 py-2.5 text-sm font-semibold text-secondary-foreground shadow-sm">
             Select a doc ←
           </div>
        </div>
      </div>
    </div>
  );
}