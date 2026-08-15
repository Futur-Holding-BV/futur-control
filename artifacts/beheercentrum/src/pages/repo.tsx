import { useQueryClient } from "@tanstack/react-query";
import { useGetRepoDetail, getGetRepoDetailQueryKey } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { 
  ArrowLeft, 
  ExternalLink,
  Clock,
  CheckCircle2,
  XCircle,
  HelpCircle,
  FileCode,
  Github,
  RefreshCw,
  ServerCrash
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatExactDate, formatTimeAgo, cn } from "@/lib/utils";
import type { CheckRun } from "@workspace/api-client-react";

function CheckStatusIcon({ status, className }: { status: "green" | "red" | "gray", className?: string }) {
  if (status === "green") return <CheckCircle2 className={cn("text-emerald-500", className)} />;
  if (status === "red") return <XCircle className={cn("text-destructive", className)} />;
  return <HelpCircle className={cn("text-muted-foreground", className)} />;
}

export default function RepoDetail() {
  const params = useParams();
  const name = params.name || "";
  const queryClient = useQueryClient();

  const { data: repo, isLoading, isError, error, isRefetching } = useGetRepoDetail(name);

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetRepoDetailQueryKey(name) });
  };

  if (isError) {
    return (
      <div className="flex flex-col gap-6 animate-in fade-in duration-500">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild className="rounded-full hover:bg-accent -ml-2 text-muted-foreground">
            <Link href="/">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
        </div>
        <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-8 flex flex-col items-center justify-center text-center gap-4 mt-8">
          <ServerCrash className="h-12 w-12 text-destructive/80" />
          <div className="space-y-2">
            <h3 className="text-lg font-medium text-destructive">Kan details niet laden</h3>
            <p className="text-sm text-destructive/80 max-w-md">
              {error?.data?.error || "Er is een probleem opgetreden bij het verbinden met de server. Controleer uw verbinding."}
            </p>
          </div>
          <Button variant="outline" onClick={handleRefresh} className="mt-4 border-destructive/20 hover:bg-destructive/20 hover:text-destructive">
            Opnieuw proberen
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading || !repo) {
    return (
      <div className="flex flex-col gap-6 animate-in fade-in duration-500">
        <div className="flex items-center gap-4">
          <div className="h-10 w-10 rounded-full bg-muted animate-pulse"></div>
          <div className="h-8 w-48 bg-muted rounded animate-pulse"></div>
        </div>
        
        <div className="h-32 w-full bg-card border border-border rounded-xl animate-pulse mt-4"></div>
        
        <div className="space-y-4 mt-4">
          <div className="h-6 w-32 bg-muted rounded animate-pulse"></div>
          {[1, 2, 3].map(i => (
            <div key={i} className="h-16 w-full bg-card border border-border rounded-xl animate-pulse"></div>
          ))}
        </div>
      </div>
    );
  }

  const isRed = repo.status === 'red';

  return (
    <div className="flex flex-col gap-8 pb-16 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      
      {/* Header Section */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" asChild className="rounded-full hover:bg-accent -ml-2 text-muted-foreground mt-0.5 shrink-0 hidden sm:flex">
            <Link href="/">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" asChild className="rounded-full hover:bg-accent -ml-2 text-muted-foreground shrink-0 sm:hidden">
                <Link href="/">
                  <ArrowLeft className="h-5 w-5" />
                </Link>
              </Button>
              <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground flex items-center gap-3">
                {repo.name}
              </h1>
            </div>
            
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground pl-0 sm:pl-0">
              {repo.lastPushAt && (
                <div className="flex items-center gap-1.5" title={formatExactDate(repo.lastPushAt)}>
                  <Clock className="h-3.5 w-3.5" />
                  <span>Laatste push {formatTimeAgo(repo.lastPushAt)}</span>
                </div>
              )}
              {repo.htmlUrl && (
                <>
                  <span className="text-border hidden sm:inline">•</span>
                  <a 
                    href={repo.htmlUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-primary hover:underline hover:text-primary/80 transition-colors"
                  >
                    <Github className="h-3.5 w-3.5" />
                    <span>Bekijk op GitHub</span>
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
        
        <Button 
          variant="outline" 
          size="sm" 
          onClick={handleRefresh}
          disabled={isRefetching}
          className="gap-2 bg-card hover:bg-accent border-border self-start shrink-0"
        >
          <RefreshCw className={cn("h-4 w-4 text-muted-foreground", isRefetching && "animate-spin")} />
          <span className="hidden sm:inline">Vernieuwen</span>
        </Button>
      </div>

      {/* Main Status Card */}
      <div className={cn(
        "rounded-2xl border p-6 sm:p-8 flex flex-col gap-6 transition-colors",
        isRed ? "bg-destructive/5 border-destructive/30" : 
        repo.status === "gray" ? "bg-card border-border" :
        "bg-emerald-500/5 border-emerald-500/30"
      )}>
        <div className="flex flex-col sm:flex-row justify-between gap-6">
          <div className="flex items-start gap-4">
            <div className={cn(
              "mt-1 p-2 rounded-xl flex-shrink-0",
              isRed ? "bg-destructive/20 text-destructive" :
              repo.status === "gray" ? "bg-muted text-muted-foreground" :
              "bg-emerald-500/20 text-emerald-500"
            )}>
              <CheckStatusIcon status={repo.status} className="h-8 w-8" />
            </div>
            <div className="space-y-2">
              <h2 className={cn(
                "text-xl font-semibold",
                isRed ? "text-destructive" : repo.status === "gray" ? "text-foreground" : "text-emerald-500"
              )}>
                {isRed ? "Laatste controle gefaald" : 
                 repo.status === "gray" ? "Geen recente controles" : 
                 "Laatste controle geslaagd"}
              </h2>
              {isRed && repo.failReason && (
                <p className="text-destructive/90 max-w-2xl text-sm sm:text-base leading-relaxed">
                  {repo.failReason}
                </p>
              )}
              {repo.lastCommitTitle && (
                <div className="inline-flex items-center gap-2 mt-2 px-3 py-1.5 rounded-md bg-background/50 border border-border/50 text-sm text-muted-foreground">
                  <FileCode className="h-4 w-4" />
                  <span className="truncate max-w-sm">{repo.lastCommitTitle}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Log Output for Failed Check */}
      {isRed && repo.failedCheck && (
        <div className="flex flex-col gap-3 animate-in slide-in-from-bottom-2 duration-500">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-lg flex items-center gap-2">
              <span className="text-destructive">Foutmelding</span>
              <span className="text-muted-foreground text-sm font-normal">in {repo.failedCheck.name}</span>
            </h3>
            <Button asChild variant="outline" size="sm" className="gap-2 text-xs border-border bg-card hover:bg-accent">
              <a href={repo.failedCheck.logUrl} target="_blank" rel="noopener noreferrer">
                Volledige log
                <ExternalLink className="h-3 w-3" />
              </a>
            </Button>
          </div>
          
          <div className="rounded-xl border border-destructive/20 bg-[#0d1117] overflow-hidden">
            <div className="flex items-center px-4 py-2 border-b border-white/10 bg-white/5">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-destructive/80"></div>
                <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80"></div>
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80"></div>
              </div>
              <span className="ml-4 text-xs font-mono text-muted-foreground">log-output</span>
            </div>
            <div className="p-4 overflow-x-auto">
              <pre className="text-xs sm:text-sm font-mono leading-relaxed text-destructive-foreground/90">
                <code>
                  {repo.failedCheck.errorLines.length > 0 ? (
                    repo.failedCheck.errorLines.map((line, i) => (
                      <div key={i} className="whitespace-pre hover:bg-white/5 px-2 -mx-2 rounded">{line || " "}</div>
                    ))
                  ) : (
                    <span className="text-muted-foreground italic">Geen specifieke regels gevonden. Bekijk de volledige log.</span>
                  )}
                </code>
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Recent Checks History */}
      {repo.checks && repo.checks.length > 0 && (
        <div className="flex flex-col gap-4 mt-4">
          <h3 className="font-semibold text-lg">Recente controles</h3>
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="divide-y divide-border">
              {repo.checks.map((check, idx) => (
                <div key={`${check.name}-${idx}`} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 hover:bg-accent/30 transition-colors">
                  <div className="flex items-center gap-3">
                    <CheckStatusIcon status={check.status} className="h-5 w-5 shrink-0" />
                    <div className="space-y-1">
                      <p className="font-medium text-sm text-card-foreground">
                        {check.name}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {check.completedAt && (
                          <span title={formatExactDate(check.completedAt)}>{formatTimeAgo(check.completedAt)}</span>
                        )}
                        {check.commitTitle && (
                          <>
                            <span>•</span>
                            <span className="truncate max-w-[200px]">{check.commitTitle}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  {check.url && (
                    <Button asChild variant="ghost" size="sm" className="shrink-0 h-8 self-start sm:self-center -ml-2 sm:ml-0 text-muted-foreground hover:text-foreground">
                      <a href={check.url} target="_blank" rel="noopener noreferrer" className="gap-2">
                        Details
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
