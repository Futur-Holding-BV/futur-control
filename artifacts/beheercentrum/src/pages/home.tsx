import { useQueryClient } from "@tanstack/react-query";
import { 
  useListRepos, getListReposQueryKey,
  useListExpiryItems,
  useListProposals
} from "@workspace/api-client-react";
import { Link } from "wouter";
import { 
  AlertTriangle, 
  Clock, 
  RefreshCw, 
  ChevronRight,
  ShieldAlert,
  GitCommitHorizontal,
  ServerCrash,
  HelpCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatTimeAgo, cn } from "@/lib/utils";
import { ProposalCard } from "@/components/proposal-card";

function StatusDot({ status, pulsing = false }: { status: "green" | "yellow" | "red" | "gray", pulsing?: boolean }) {
  return (
    <div className="relative flex h-3 w-3 items-center justify-center">
      {pulsing && status === 'red' && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75"></span>
      )}
      {pulsing && status === 'green' && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-50"></span>
      )}
      <span className={cn(
        "relative inline-flex h-2.5 w-2.5 rounded-full",
        status === "green" ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]" :
        status === "yellow" ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]" :
        status === "red" ? "bg-destructive shadow-[0_0_8px_rgba(239,68,68,0.8)]" :
        "bg-muted-foreground"
      )}></span>
    </div>
  );
}

export default function Home() {
  const queryClient = useQueryClient();
  const { data: repos, isLoading, isError, error, isRefetching } = useListRepos();
  const { data: expiryItems } = useListExpiryItems();
  const { data: proposals } = useListProposals();

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: getListReposQueryKey() });
  };

  const anomalies = repos?.flatMap(r => 
    r.anomaly ? [{ repoName: r.name, ...r.anomaly }] : []
  ) || [];

  return (
    <div className="flex flex-col gap-6 w-full pb-12 animate-in fade-in slide-in-from-bottom-4 duration-700 ease-out">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Overzicht Codebases</h1>
          <p className="text-sm text-muted-foreground">Laatste status van alle actieve projecten.</p>
        </div>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={handleRefresh}
          disabled={isLoading || isRefetching}
          className="gap-2 bg-card hover:bg-accent border-border"
        >
          <RefreshCw className={cn("h-4 w-4 text-muted-foreground", (isLoading || isRefetching) && "animate-spin")} />
          <span className="hidden sm:inline">Vernieuwen</span>
        </Button>
      </div>

      {isError && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-6 flex flex-col items-center justify-center text-center gap-3">
          <ServerCrash className="h-10 w-10 text-destructive/80" />
          <div className="space-y-1">
            <h3 className="font-medium text-destructive">Fout bij ophalen van gegevens</h3>
            <p className="text-sm text-destructive/80 max-w-sm">
              {error?.data?.error || "De server is momenteel onbereikbaar. Probeer het later opnieuw."}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh} className="mt-2 border-destructive/20 hover:bg-destructive/20 hover:text-destructive">
            Opnieuw proberen
          </Button>
        </div>
      )}

      {/* Loopt af block */}
      {expiryItems && expiryItems.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Loopt af</h2>
          <div className="grid grid-cols-1 gap-3">
            {expiryItems.map(item => {
              const isRed = item.severity === 'red';
              const isOrange = item.severity === 'orange';
              const isUnknown = item.severity === 'unknown';
              return (
                <div key={item.id} className={cn(
                  "rounded-xl border p-4 flex flex-col gap-2",
                  isRed ? "bg-destructive/10 border-destructive/30" :
                  isOrange ? "bg-amber-500/10 border-amber-500/30" :
                  isUnknown ? "bg-muted/50 border-muted-foreground/30" :
                  "bg-card border-border"
                )}>
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div>
                      <h3 className={cn("font-medium flex items-center gap-2", 
                        isRed ? "text-destructive" :
                        isOrange ? "text-amber-500" :
                        isUnknown ? "text-muted-foreground" :
                        "text-foreground"
                      )}>
                        {isRed && <AlertTriangle className="h-4 w-4" />}
                        {isOrange && <AlertTriangle className="h-4 w-4" />}
                        {isUnknown && <HelpCircle className="h-4 w-4" />}
                        {item.label}
                      </h3>
                      <p className="text-sm mt-1 text-muted-foreground leading-relaxed">{item.consequence}</p>
                    </div>
                    <div className="text-left sm:text-right shrink-0 mt-2 sm:mt-0 sm:max-w-[260px]">
                      {isUnknown ? (
                        <div className="text-sm font-medium text-muted-foreground">
                          Onbekend
                          <div className="text-xs font-normal opacity-80 mt-0.5">{item.unknownReason}</div>
                        </div>
                      ) : (
                        <div className={cn("text-sm font-medium", isRed ? "text-destructive" : isOrange ? "text-amber-500" : "text-foreground")}>
                          {item.daysLeft != null && item.daysLeft < 0 ? 'Verlopen' : 
                           item.daysLeft != null ? `Nog ${item.daysLeft} dagen` : ''}
                          <div className="text-xs font-normal opacity-80 mt-0.5">
                            {item.expiresAt ? new Date(item.expiresAt).toLocaleDateString('nl-NL') : ''}
                          </div>
                          {item.staleNote && (
                            <div className="text-xs font-normal opacity-70 mt-0.5 italic">{item.staleNote}</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Proposals block */}
      {proposals && proposals.length > 0 && (
        <div className="flex flex-col gap-3 mt-2">
          <h2 className="text-lg font-semibold tracking-tight text-primary">Voorstellen</h2>
          <div className="grid grid-cols-1 gap-3">
            {proposals.map(proposal => (
              <ProposalCard key={proposal.id} proposal={proposal} />
            ))}
          </div>
        </div>
      )}

      {/* Anomalies */}
      {!isError && anomalies.length > 0 && (
        <div className="flex flex-col gap-3 mt-2">
          {anomalies.map((anomaly, idx) => (
            <div 
              key={`${anomaly.repoName}-${anomaly.commitSha}-${idx}`}
              className="group relative overflow-hidden rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 transition-all hover:bg-amber-500/15"
            >
              <div className="absolute inset-y-0 left-0 w-1 bg-amber-500" />
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pl-2">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 p-1 rounded-md bg-amber-500/20 text-amber-500">
                    <ShieldAlert className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="font-semibold text-amber-500 flex items-center gap-2">
                      Afwijking gedetecteerd in {anomaly.repoName}
                    </h3>
                    <p className="text-sm text-amber-200/80 leading-relaxed max-w-2xl">
                      Ongewoon grote wijziging ({anomaly.linesChanged} regels) in <span className="font-mono text-xs bg-amber-950/50 px-1.5 py-0.5 rounded text-amber-300">{anomaly.fileName}</span>.
                    </p>
                    <div className="flex items-center gap-2 mt-2 text-xs text-amber-400/60">
                      <GitCommitHorizontal className="h-3.5 w-3.5" />
                      <span className="truncate max-w-[200px] sm:max-w-md">{anomaly.commitTitle}</span>
                    </div>
                  </div>
                </div>
                <Button asChild variant="outline" size="sm" className="shrink-0 border-amber-500/30 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300">
                  <a href={anomaly.commitUrl} target="_blank" rel="noopener noreferrer">
                    Bekijk Commit
                  </a>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {isLoading && !repos && (
        <div className="flex flex-col gap-3 mt-2">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-24 w-full rounded-xl bg-card border border-border animate-pulse flex items-center p-4 gap-4">
              <div className="h-10 w-10 rounded-full bg-muted"></div>
              <div className="space-y-3 flex-1">
                <div className="h-4 w-1/3 bg-muted rounded"></div>
                <div className="h-3 w-1/4 bg-muted rounded"></div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!isLoading && !isError && repos?.length === 0 && (
        <div className="flex flex-col items-center justify-center p-12 text-center rounded-xl border border-border border-dashed bg-card/50 mt-2">
          <p className="text-muted-foreground">Geen codebases gevonden in deze organisatie.</p>
        </div>
      )}

      <div className="flex flex-col gap-3 mt-2">
        {repos?.map((repo, idx) => {
          const isRed = repo.status === 'red';
          const isGray = repo.status === 'gray';
          const isYellow = repo.status === 'yellow';
          
          return (
            <Link 
              key={repo.name} 
              href={`/repo/${repo.name}`}
              className={cn(
                "group relative flex flex-col overflow-hidden rounded-xl border bg-card p-4 transition-all duration-300 hover:shadow-md sm:p-5 outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                isRed ? "border-destructive/30 hover:border-destructive/60 hover:bg-destructive/5" : 
                isYellow ? "border-amber-400/30 hover:border-amber-400/60 hover:bg-amber-400/5" :
                isGray ? "border-border hover:border-muted-foreground/30 hover:bg-accent/50" : 
                "border-border hover:border-emerald-500/30 hover:bg-emerald-500/5"
              )}
              style={{ animationDelay: `${idx * 50}ms` }}
            >
              <div className={cn(
                "absolute inset-y-0 left-0 w-1 transition-transform duration-300 origin-left scale-x-0 group-hover:scale-x-100",
                isRed ? "bg-destructive" :
                isYellow ? "bg-amber-400" :
                isGray ? "bg-muted-foreground" :
                "bg-emerald-500"
              )} />
              
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-1 items-start gap-4">
                  <div className="mt-1 flex-shrink-0">
                    <StatusDot status={repo.status} pulsing={isRed} />
                  </div>
                  
                  <div className="flex flex-col gap-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold text-base text-card-foreground truncate">{repo.name}</h2>
                      {isRed && (
                        <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive ring-1 ring-inset ring-destructive/20">
                          Faalt
                        </span>
                      )}
                      {isYellow && (
                        <span className="inline-flex items-center rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-500 ring-1 ring-inset ring-amber-400/20">
                          Verouderd
                        </span>
                      )}
                      {repo.recoveredAfterRetry && !isRed && (
                        <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500 ring-1 ring-inset ring-emerald-500/20">
                          Hersteld na herhaling
                        </span>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                      <Clock className="h-3 w-3" />
                      <span>{repo.lastPushAt ? formatTimeAgo(repo.lastPushAt) : 'Nooit gepusht'}</span>
                      {repo.lastCommitTitle && (
                        <>
                          <span className="text-border mx-1">•</span>
                          <span className="truncate max-w-[150px] sm:max-w-xs">{repo.lastCommitTitle}</span>
                        </>
                      )}
                    </div>

                    {isRed && repo.failReason && (
                      <div className="mt-3 flex items-start gap-2 rounded-lg bg-destructive/10 p-2.5 border border-destructive/10">
                        <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                        <span className="text-sm text-destructive/90 leading-snug">
                          {repo.failReason}
                        </span>
                      </div>
                    )}
                    {isGray && repo.staleReason && (
                      <div className="mt-3 flex items-start gap-2 rounded-lg bg-muted/60 p-2.5 border border-border">
                        <HelpCircle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                        <span className="text-sm text-muted-foreground leading-snug">
                          {repo.staleReason}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center self-center sm:self-start mt-2 sm:mt-0 text-muted-foreground group-hover:text-foreground transition-colors">
                  <ChevronRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
