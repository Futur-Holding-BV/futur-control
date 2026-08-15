import { useListActionLog } from "@workspace/api-client-react";
import { formatExactDate, formatTimeAgo } from "@/lib/utils";
import { ClipboardList, Info } from "lucide-react";

export default function Logboek() {
  const { data: logs, isLoading, isError } = useListActionLog();

  return (
    <div className="flex flex-col gap-6 w-full pb-12 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div className="space-y-1">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight flex items-center gap-2">
          <ClipboardList className="h-6 w-6 text-primary" />
          Logboek Acties
        </h1>
        <p className="text-sm text-muted-foreground">
          Overzicht van automatische acties en eenmalige goedkeuringen.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-24 bg-card border border-border rounded-xl animate-pulse" />
          ))}
        </div>
      ) : isError ? (
        <div className="p-6 bg-destructive/10 border border-destructive/20 rounded-xl text-destructive text-center">
          Er is een fout opgetreden bij het laden van het logboek.
        </div>
      ) : !logs || logs.length === 0 ? (
        <div className="p-12 bg-card border border-border border-dashed rounded-xl text-center flex flex-col items-center gap-3">
          <Info className="h-8 w-8 text-muted-foreground" />
          <p className="text-muted-foreground">
            Er zijn nog geen automatische of eenmalige acties uitgevoerd.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {logs.map(log => (
            <div key={log.id} className="p-5 bg-card border border-border rounded-xl flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
                <div>
                  <h3 className="font-medium text-foreground">{log.action}</h3>
                  {log.repo && <p className="text-sm font-medium text-primary mt-0.5">{log.repo}</p>}
                </div>
                <div className="text-left sm:text-right text-xs text-muted-foreground shrink-0 mt-2 sm:mt-0">
                  <div className="font-medium text-foreground">{formatTimeAgo(log.createdAt)}</div>
                  <div className="mt-0.5 opacity-80">{formatExactDate(log.createdAt)}</div>
                </div>
              </div>
              <div className="p-3 bg-muted/30 rounded-lg text-sm space-y-2 border border-border/50">
                <div>
                  <span className="font-medium text-foreground/80">Reden: </span>
                  <span className="text-muted-foreground">{log.reason}</span>
                </div>
                <div>
                  <span className="font-medium text-foreground/80">Resultaat: </span>
                  <span className="text-muted-foreground">{log.outcome}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
