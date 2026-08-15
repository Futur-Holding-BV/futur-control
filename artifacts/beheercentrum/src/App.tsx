import { Link, Route, Switch, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Bell, ShieldCheck, ClipboardList } from "lucide-react";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import RepoDetail from "@/pages/repo";
import NotificationsPage from "@/pages/notifications";
import Logboek from "@/pages/logboek";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    }
  }
});

function Header() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl">
      <div className="container mx-auto max-w-4xl flex h-16 items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-80">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary border border-primary/20">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold leading-none text-foreground tracking-tight">FPS-Beheercentrum</span>
            <span className="text-[10px] uppercase font-medium tracking-widest text-muted-foreground mt-1">Systeemstatus</span>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href="/logboek"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ClipboardList className="h-4 w-4" />
            <span className="hidden sm:inline">Logboek</span>
          </Link>
          <Link
            href="/notifications"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Bell className="h-4 w-4" />
            <span className="hidden sm:inline">Meldingen</span>
          </Link>
        </div>
      </div>
    </header>
  );
}

function Router() {
  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground selection:bg-primary/30">
      <Header />
      <main className="flex-1 container mx-auto max-w-4xl px-4 py-6 md:py-8 flex flex-col">
        <RoutedErrorBoundary>
          <Switch>
            <Route path="/" component={Home} />
            <Route path="/repo/:name" component={RepoDetail} />
            <Route path="/notifications" component={NotificationsPage} />
            <Route path="/logboek" component={Logboek} />
            <Route component={NotFound} />
          </Switch>
        </RoutedErrorBoundary>
      </main>
    </div>
  );
}

function RoutedErrorBoundary({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

import { Router as WouterRouter } from "wouter";

export default App;
