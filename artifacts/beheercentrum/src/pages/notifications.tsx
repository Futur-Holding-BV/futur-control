import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGetNotificationSettingsQueryKey,
  getListFindingLevelsQueryKey,
  getNotificationSettings,
  useListFindings,
  useListFindingLevels,
  useUpdateFindingLevel,
} from "@workspace/api-client-react";
import {
  Bell,
  BellOff,
  CheckCircle2,
  ExternalLink,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PushSettingsCard } from "@/components/push-settings-card";
import { LeesSleutelsCard } from "@/components/lees-sleutels-card";
import { MailSettingsCard } from "@/components/mail-settings-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const KIND_LABELS: Record<string, string> = {
  public_service_unavailable: "Publieke dienst onbereikbaar",
  certificate_invalid: "Certificaat verlopen of ongeldig",
  monitor_unhealthy: "Bewaking meet niet meer",
  credential_expired: "Sleutel verlopen",
  database_unavailable: "Database onbereikbaar",
  build_failed: "Bouwcontrole gefaald",
  anomaly: "Afwijkend grote wijziging",
  domain_expiry: "Domeinverval",
  repo_without_check: "Codebase zonder werkende controle",
};

export default function NotificationsPage() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: getGetNotificationSettingsQueryKey(),
    queryFn: () => getNotificationSettings(),
  });
  const { data: levels, isLoading: levelsLoading } = useListFindingLevels();
  const { data: findings, isLoading: findingsLoading } = useListFindings();
  const updateLevel = useUpdateFindingLevel({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListFindingLevelsQueryKey() });
      },
    },
  });

  const openFindings = findings?.filter((finding) => finding.resolvedAt === null) ?? [];

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-6 overflow-x-clip pb-12 animate-in fade-in slide-in-from-bottom-4 duration-700 ease-out">
      <div className="space-y-1">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Meldingen</h1>
        <p className="text-sm text-muted-foreground">
          Beheer hoe en wanneer je gealarmeerd wordt bij problemen en afwijkingen.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Instellingen ophalen…
        </div>
      ) : (
        <div className="flex flex-col gap-6">

          <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
            {/* Active / inactive status */}
            <div className="min-w-0 rounded-xl border border-border bg-card p-5 flex items-start gap-4">
              <div className={cn(
                "p-2.5 rounded-xl shrink-0 mt-0.5",
                settings?.enabled
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground",
              )}>
                {settings?.enabled ? <Bell className="h-5 w-5" /> : <BellOff className="h-5 w-5" />}
              </div>
              <div className="space-y-1">
                <h3 className="font-medium text-sm">
                  {settings?.enabled ? "Meldingen zijn actief" : "Meldingen zijn uitgeschakeld"}
                </h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {settings?.enabled
                    ? "De achtergrondmonitor verstuurt notificaties op basis van de onderstaande configuratie."
                    : "Zet NOTIFICATIONS_ENABLED=true in de configuratie om meldingen te activeren."}
                </p>
              </div>
            </div>

            {/* Webhook status */}
            <div className="min-w-0 rounded-xl border border-border bg-card p-5 flex flex-col gap-4">
              <div className="flex items-start gap-4">
                <div className={cn(
                  "p-2.5 rounded-xl shrink-0 mt-0.5",
                  settings?.slackWebhookConfigured
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                )}>
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="font-medium text-sm flex items-center gap-2">
                    Slack webhook
                    {settings?.slackWebhookConfigured ? (
                       <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                       <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    )}
                  </h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {settings?.slackWebhookConfigured
                      ? "Webhook is correct geconfigureerd en actief."
                      : "Geen webhook ingesteld. Notificaties naar Slack worden niet verstuurd."}
                  </p>
                </div>
              </div>

              {!settings?.slackWebhookConfigured && (
                <div className="rounded-lg bg-muted/30 border border-border/50 p-4 space-y-3">
                  <p className="text-xs font-medium">Zo stel je de webhook in:</p>
                  <ol className="list-decimal list-inside space-y-2 text-muted-foreground text-xs leading-relaxed">
                    <li>
                      Maak een app op{" "}
                      <a
                        href="https://api.slack.com/apps"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
                      >
                        api.slack.com
                        <ExternalLink className="h-3 w-3" />
                      </a>{" "}
                      en activeer <strong>Incoming Webhooks</strong>.
                    </li>
                    <li>
                      Voeg de webhook-URL toe als Replit Secret <code className="break-all bg-background border border-border/40 px-1 py-0.5 rounded font-mono text-[10px]">SLACK_WEBHOOK_URL</code>.
                    </li>
                    <li>Herstart de API-server.</li>
                  </ol>
                </div>
              )}
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-6">
               <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden flex flex-col">
                 <div className="p-5 border-b border-border/40 space-y-1 bg-muted/10">
                   <div className="flex items-center justify-between">
                     <div className="flex items-center gap-2">
                       <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                       <h2 className="font-medium text-sm">Open bevindingen</h2>
                     </div>
                     {openFindings.length > 0 && (
                       <span className="bg-background border border-border/40 px-2 py-0.5 rounded-full text-xs font-medium text-muted-foreground">
                         {openFindings.length}
                       </span>
                     )}
                   </div>
                   <p className="text-xs text-muted-foreground">
                     Actuele problemen die wachten op afhandeling of de dagelijkse samenvatting.
                   </p>
                 </div>

                 <div>
                   {findingsLoading ? (
                      <div className="p-8 flex items-center justify-center text-muted-foreground text-sm">
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Bevindingen inladen…
                      </div>
                   ) : openFindings.length === 0 ? (
                      <div className="p-8 flex flex-col items-center justify-center text-center">
                         <div className="h-10 w-10 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-3">
                            <CheckCircle2 className="h-5 w-5" />
                         </div>
                         <p className="text-sm font-medium">Alles in orde</p>
                         <p className="text-xs text-muted-foreground mt-1 max-w-[220px]">Er staan momenteel geen bevindingen open.</p>
                      </div>
                   ) : (
                      <div className="divide-y divide-border/40">
                         {openFindings.map((finding) => (
                            <div key={finding.id} className="p-4 flex flex-col gap-2 hover:bg-muted/10 transition-colors">
                               <div className="flex items-start justify-between gap-4">
                                 <p className="text-sm font-medium leading-tight text-foreground/90">{finding.title}</p>
                                 <span className={cn(
                                   "shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
                                   finding.level === "NU"
                                     ? "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20"
                                     : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                                 )}>
                                   {finding.level === "NU" ? "NU" : "KAN WACHTEN"}
                                 </span>
                               </div>
                               <p className="text-xs text-muted-foreground leading-relaxed">{finding.detail}</p>
                            </div>
                         ))}
                      </div>
                   )}
                 </div>
               </section>

               {/* Trigger info */}
               <section className="rounded-xl border border-border/60 bg-muted/30 p-5 space-y-3">
                 <h2 className="text-sm font-medium">Werking van meldingen</h2>
                 <div className="text-xs text-muted-foreground space-y-2.5 leading-relaxed">
                   <p>
                     <strong className="text-foreground/80 font-medium">NU:</strong> Direct alarm buiten het stiltevenster. Bijvoorbeeld bij een onbereikbare publieke dienst of uitgevallen bewaking.
                   </p>
                   <p>
                     <strong className="text-foreground/80 font-medium">KAN WACHTEN:</strong> Wordt meegenomen in de dagelijkse samenvatting (17:00). Voor minder kritieke zaken zoals bouwfouten.
                   </p>
                   <p>
                     De monitor controleert continu. Bevindingen die uit zichzelf herstellen (of handmatig worden opgelost) verdwijnen zonder extra melding.
                   </p>
                 </div>
               </section>
            </div>

            <div className="flex min-w-0 flex-col gap-6">
              <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden flex flex-col">
                <div className="p-5 border-b border-border/40 space-y-1 bg-muted/10">
                  <div className="flex items-center gap-2">
                    <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
                    <h2 className="font-medium text-sm">Prioriteit per type</h2>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Bepaal of een bevinding direct gemeld moet worden (NU) of tot het einde van de dag kan wachten.
                  </p>
                </div>

                <div>
                  {levelsLoading ? (
                    <div className="p-8 flex items-center justify-center text-muted-foreground text-sm">
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Niveaus inladen…
                    </div>
                  ) : (
                    <div className="divide-y divide-border/40">
                      {levels?.map((setting) => (
                        <div key={setting.kind} className="p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between hover:bg-muted/10 transition-colors">
                          <span className="text-sm font-medium text-foreground/90">{KIND_LABELS[setting.kind] ?? setting.kind}</span>
                          <Select
                            value={setting.level}
                            disabled={updateLevel.isPending}
                            onValueChange={(level: "NU" | "KAN_WACHTEN") =>
                              updateLevel.mutate({ kind: setting.kind, data: { level } })
                            }
                          >
                            <SelectTrigger className={cn(
                              "w-full sm:w-[140px] h-8 text-[11px] font-semibold tracking-wide uppercase transition-colors shadow-none",
                              setting.level === "NU"
                                ? "text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20 hover:bg-red-500/20"
                                : "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/20"
                            )}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="NU" className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">NU</SelectItem>
                              <SelectItem value="KAN_WACHTEN" className="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide">Kan Wachten</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* Delivery channels */}
              <MailSettingsCard mailConfigured={Boolean(settings?.mailConfigured)} />
              <PushSettingsCard />
              <LeesSleutelsCard />
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
